// Room manages the local peer's mesh: signaling, per-remote-peer connections,
// the group key, the wiring between mic capture and outbound senders, and
// best-effort recovery from transient signaling/ICE failures.
//
// State machine:
//   idle → connecting → in-room → leaving → idle
//
// Failure handling:
//   - On WebSocket close that wasn't user-initiated, redial with exponential
//     backoff and rejoin the same code. Existing peers see a peer_left for
//     our old peer ID and a peer_joined for the new one; their PCs get
//     rebuilt. We tear ours down on the same trigger because the remote
//     side has already disposed of them.
//   - On a peer connection going `failed`, the offerer kicks one ICE restart.
//     Two failures in a row are treated as terminal for that peer.

import {
  observeSpeaking,
  playJoinTone,
  playLeaveTone,
} from "./audio.ts";
import {
  generateEphemeralKeypair,
  generateGroupKey,
  unwrapGroupKey,
  wrapGroupKey,
  type EphemeralKeypair,
} from "./crypto.ts";
import { GroupCipher, isE2EEAvailable } from "./e2ee.ts";
import { Peer, turnCredsToIceServers, type PeerDiagnostics, type PeerStats } from "./peer.ts";
import { SignalingClient, signalingURL } from "./signaling.ts";
import {
  startShareCapture,
  stopShareCapture,
  type ShareCapture,
  type ShareMode,
} from "./screen.ts";
export type { ShareMode } from "./screen.ts";
import type { MicCapture } from "./audio.ts";
import type { ServerEnvelope, SignalData, TurnCreds, PeerInfo } from "./wire.ts";

// newChatId returns a short, unique-enough identifier for a chat message.
// It only needs to be unique among messages from this client during this
// session (recipients namespace ids by author peer ID). 16 hex chars from
// crypto.getRandomValues comfortably covers a single chat session.
function newChatId(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let s = "";
  for (const b of buf) s += b.toString(16).padStart(2, "0");
  return s;
}

// Reconnect backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, 30s. Cap at 30s and stop
// after MAX_RECONNECT_ATTEMPTS attempts so we don't spin forever for a
// truly-dead network.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

// Diagnostics is the snapshot the connection-diagnostics panel renders. It
// gathers room-level state (signaling, TURN, reconnect attempts) plus the
// per-peer view from Peer.diagnostics(). Designed so the entire JSON blob
// can be copied to clipboard for sharing without losing context.
export interface Diagnostics {
  capturedAt: number;
  status: "connecting" | "reconnecting" | "connected" | "left";
  // intentStartedAt is the wall-clock ms when the user clicked Create/Join,
  // used to compute "stuck for Xs" while connecting. Reset on each reconnect.
  intentStartedAt: number | null;
  reconnectAttempt: number;
  code: string | null;
  localId: string | null;
  ws: "open" | "connecting" | "closed";
  turn: {
    received: boolean;
    uris: string[];
    // ttlSecondsRemaining is the original ttl minus the time since we received
    // the creds; null when we never received any.
    ttlSecondsRemaining: number | null;
  };
  peers: (PeerDiagnostics & { name: string })[];
  local: { userAgent: string; onLine: boolean };
}

export interface ChatMessage {
  // id uniquely identifies this message within the room (sender-generated
  // at send time). Used to address later edits and deletes.
  id: string;
  // from is the author's peer ID — equal to our local peer ID when isSelf
  // is true. UI uses it as a stable handle to update past bubbles when
  // the author renames.
  from: string;
  isSelf: boolean;
  // name is the author's current display name at the time the message
  // arrived. Subsequent renames are dispatched via onPeerRenamed and the
  // UI is responsible for refreshing past bubbles.
  name: string;
  body: string;
  ts: number;
}

export interface RoomCallbacks {
  onJoined: (info: { code: string; localId: string; name: string }) => void;
  onPeerAdded: (id: string, name: string) => void;
  onPeerRemoved: (id: string, name: string) => void;
  onPeerRenamed: (id: string, name: string) => void;
  onRemoteStream: (id: string, stream: MediaStream) => void;
  onSpeakingChange: (id: string, speaking: boolean) => void;
  onConnectionState: (id: string, state: RTCPeerConnectionState) => void;
  // onCipherHealth fires when sustained decrypt failures cross a threshold
  // (healthy=false) and again when decryption recovers (healthy=true).
  onCipherHealth: (id: string, healthy: boolean) => void;
  onChatMessage: (msg: ChatMessage) => void;
  // onChatEdited fires when an existing message is edited by its author.
  // The UI looks up the message by id and rewrites the body.
  onChatEdited: (info: { id: string; body: string; editedTs: number }) => void;
  // onChatDeleted fires when an existing message is deleted by its author.
  onChatDeleted: (info: { id: string }) => void;
  // onPresenterChanged fires when the room's current screen-sharer changes:
  // peerId is the new presenter's ID (local or remote), or null when nobody
  // is sharing. stream is the screen MediaStream when applicable, or null
  // when sharing stopped. Self-presenter notifications surface the local
  // capture stream so the UI can render a local preview.
  onPresenterChanged: (peerId: string | null, stream: MediaStream | null) => void;
  onLeft: (reason: string) => void;
  onError: (msg: string) => void;
  // onReconnecting/onReconnected let the UI surface "trying to reconnect..."
  // without conflating it with a final disconnect. onReconnected carries
  // the freshly-issued local peer ID — the server hands out a new ID on
  // every join, so any caller-side cache (e.g. main.ts isSelf checks)
  // must refresh.
  onReconnecting: (attempt: number) => void;
  onReconnected: (info: { localId: string }) => void;
}

interface JoinIntent {
  kind: "create" | "join";
  code: string;
  name: string;
}

export class Room {
  private cb: RoomCallbacks;
  private mic: MicCapture;
  private signaling: SignalingClient;
  private keypair!: EphemeralKeypair;
  private peers = new Map<string, Peer>();
  // names tracks the latest known display name for every peer in the room
  // (including self). Used to attribute chat messages and to surface the
  // departing name on peer_left for the system "X left" line.
  private names = new Map<string, string>();
  // chatAuthors maps message id -> author peer ID for every chat message
  // we've seen (own + remote). Used to verify that incoming edit/delete
  // events come from the original author's data channel; an event arriving
  // on a different peer's channel is dropped. Cleaned up on peer_left for
  // remote authors so the map doesn't grow without bound; own ids stay so
  // we can keep editing/deleting after others come and go.
  private chatAuthors = new Map<string, string>();
  private localName = "";
  // iceRetried tracks per-peer ICE-restart attempts so we don't loop on a
  // truly-dead path.
  private iceRetried = new Set<string>();
  private localId: string | null = null;
  private code: string | null = null;
  private iceServers: RTCIceServer[] = [];
  // turnCreds + turnReceivedAt let diagnostics() report whether the server
  // issued TURN credentials and how much of their TTL remains. Cleared on
  // teardown; refreshed each time room_created/room_joined arrives (which
  // is how Cloudflare creds get rotated mid-session via reconnect).
  private turnCreds: TurnCreds | null = null;
  private turnReceivedAt: number | null = null;
  // intentStartedAt is set when the user first dials (create/join) and on
  // each reconnect attempt. Diagnostics uses it to show "Connecting · Xs".
  private intentStartedAt: number | null = null;
  // reconnectAttempt is the most recent attempt number (1-indexed) reported
  // to onReconnecting; 0 when we're not currently reconnecting.
  private reconnectAttempt = 0;
  private cipher: GroupCipher | null = null;
  private groupKeyRaw: Uint8Array | null = null;
  private stopSelfVAD: (() => void) | null = null;
  // intent records what we did to enter the room so we can replay it on
  // reconnect. Cleared by leave/teardown.
  private intent: JoinIntent | null = null;
  private leaving = false;
  private reconnecting = false;
  // Screen-share state. capture is non-null while we're the presenter;
  // presenterId is whoever the room currently considers the presenter
  // (local, remote, or null). The advisory `screen` signal resolves which
  // remote peer is sharing before the video track arrives, but the UI also
  // updates from onScreenTrack so a missed signal still self-heals.
  private capture: ShareCapture | null = null;
  private presenterId: string | null = null;
  private remoteScreens = new Map<string, MediaStream>();

  constructor(mic: MicCapture, cb: RoomCallbacks) {
    this.mic = mic;
    this.cb = cb;
    this.signaling = new SignalingClient(
      (env) => void this.onServerEvent(env),
      () => this.onSignalingClosed(),
    );
  }

  // create dials the signaling server, generates keys, and asks for a new
  // room. The room creator generates the initial group key.
  async create(name: string): Promise<void> {
    this.intent = { kind: "create", code: "", name };
    this.intentStartedAt = Date.now();
    await this.dialAndHandshake(async () => {
      this.signaling.send({
        type: "create_room",
        payload: { publicKey: this.keypair.publicKey, supportsE2EE: isE2EEAvailable(), name },
      });
    });
  }

  // join dials the signaling server with an existing room code.
  async join(code: string, name: string): Promise<void> {
    this.intent = { kind: "join", code, name };
    this.intentStartedAt = Date.now();
    await this.dialAndHandshake(async () => {
      this.signaling.send({
        type: "join_room",
        payload: { code, publicKey: this.keypair.publicKey, supportsE2EE: isE2EEAvailable(), name },
      });
    });
  }

  rename(name: string): void {
    if (this.intent) this.intent.name = name;
    try {
      this.signaling.send({ type: "rename", payload: { name } });
    } catch (err) {
      console.warn("rename send failed", err);
    }
  }

  // sendChat broadcasts a chat message over every open peer-to-peer data
  // channel and immediately surfaces it to the local UI as a self message.
  // Returns true if at least one peer received it (or there are no peers,
  // i.e. the user is talking to themselves but the message still renders
  // locally). Empty/whitespace-only bodies are dropped.
  sendChat(body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed || !this.localId) return false;
    const ts = Date.now();
    const id = newChatId();
    this.chatAuthors.set(id, this.localId);
    for (const peer of this.peers.values()) peer.sendChat(id, trimmed, ts);
    this.cb.onChatMessage({
      id,
      from: this.localId,
      isSelf: true,
      name: this.localName,
      body: trimmed,
      ts,
    });
    return true;
  }

  // editChat broadcasts an edit of a previously-sent message and updates
  // the local UI. Only own messages can be edited; the local author check
  // mirrors what receivers enforce. Empty/whitespace-only bodies are
  // rejected (use deleteChat instead).
  editChat(id: string, body: string): boolean {
    const trimmed = body.trim();
    if (!trimmed || !this.localId) return false;
    if (this.chatAuthors.get(id) !== this.localId) return false;
    const editedTs = Date.now();
    for (const peer of this.peers.values()) peer.sendChatEdit(id, trimmed, editedTs);
    this.cb.onChatEdited({ id, body: trimmed, editedTs });
    return true;
  }

  // deleteChat broadcasts a delete of a previously-sent message and updates
  // the local UI.
  deleteChat(id: string): boolean {
    if (!this.localId) return false;
    if (this.chatAuthors.get(id) !== this.localId) return false;
    for (const peer of this.peers.values()) peer.sendChatDelete(id);
    this.cb.onChatDeleted({ id });
    return true;
  }

  leave(): void {
    this.leaving = true;
    try {
      this.signaling.send({ type: "leave_room", payload: {} });
    } catch {
      // socket may already be closed
    }
    this.teardown("user left");
  }

  // setOutboundTrack swaps the mic track on every existing peer. Used when
  // the user changes input device or toggles noise suppression.
  setOutboundTrack(track: MediaStreamTrack): void {
    for (const p of this.peers.values()) p.setLocalTrack(track);
  }

  private async dialAndHandshake(send: () => Promise<void>): Promise<void> {
    this.keypair = await generateEphemeralKeypair();
    await this.signaling.connect(signalingURL());
    await send();
  }

  private onSignalingClosed(): void {
    if (this.leaving) return;
    if (this.localId === null) {
      // Closed before we ever joined — treat as a hard failure; nothing to
      // recover from yet.
      return;
    }
    // Tear down peer connections immediately: the remote side has already
    // dropped us (the server broadcast peer_left when our socket closed),
    // so the existing PCs are dead either way. We'll rebuild on reconnect.
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.iceRetried.clear();
    this.names.clear();
    this.cipher = null;
    if (this.groupKeyRaw) this.groupKeyRaw.fill(0);
    this.groupKeyRaw = null;
    // Capture survives reconnect: addPeer (during the upcoming room_joined
    // / room_created) re-installs the screen tracks on each fresh peer,
    // and we re-announce via the screen signal. Remote presenter state,
    // by contrast, can't survive — their PCs are torn down here. The
    // self-presenter's UI keeps the pane up throughout.
    if (this.presenterId && this.presenterId !== this.localId) {
      this.presenterId = null;
      this.remoteScreens.clear();
      this.cb.onPresenterChanged(null, null);
    }
    this.localId = null;
    void this.attemptReconnect();
  }

  private async attemptReconnect(): Promise<void> {
    if (!this.intent) {
      this.cb.onLeft("signaling closed");
      return;
    }
    this.reconnecting = true;
    for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
      this.reconnectAttempt = attempt + 1;
      this.intentStartedAt = Date.now();
      this.cb.onReconnecting(attempt + 1);
      await sleep(RECONNECT_DELAYS_MS[attempt]!);
      if (this.leaving) return;
      try {
        // Re-key for the new session: a brand-new ephemeral X25519 pair so
        // peers re-derive a fresh wrap channel for us.
        this.keypair = await generateEphemeralKeypair();
        await this.signaling.connect(signalingURL());
        // On reconnect we always send `join_room` for the same code, even
        // for the room creator: by the time we get back the room may have
        // continued without us, so we should join whatever is there. If
        // we were the only one in the room and the cooldown expired, the
        // server will recreate the room from the same code (attachPeer's
        // create-on-miss path).
        const code = this.intent.kind === "create" && this.code ? this.code : this.intent.code;
        if (!code) {
          throw new Error("no code to rejoin");
        }
        this.signaling.send({
          type: "join_room",
          payload: {
            code,
            publicKey: this.keypair.publicKey,
            supportsE2EE: isE2EEAvailable(),
            name: this.intent.name,
          },
        });
        // The first server event (room_created or room_joined) will clear
        // `reconnecting` and call onReconnected. We return here; the rest
        // is async via onServerEvent.
        return;
      } catch (err) {
        console.warn("reconnect attempt failed", attempt + 1, err);
        try {
          this.signaling.close();
        } catch {
          /* ignore */
        }
      }
    }
    // Out of attempts — give up. teardown closes any straggling state
    // (notably the screen capture, which survives transient signaling
    // drops but must be released when we're conceding the room).
    this.reconnecting = false;
    this.teardown("reconnect failed");
  }

  private teardown(reason: string): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.iceRetried.clear();
    this.names.clear();
    this.chatAuthors.clear();
    this.localName = "";
    this.stopSelfVAD?.();
    this.stopSelfVAD = null;
    this.signaling.close();
    if (this.groupKeyRaw) this.groupKeyRaw.fill(0);
    this.groupKeyRaw = null;
    this.cipher = null;
    if (this.capture) {
      stopShareCapture(this.capture);
      this.capture = null;
    }
    if (this.presenterId !== null) {
      this.presenterId = null;
      this.remoteScreens.clear();
      this.cb.onPresenterChanged(null, null);
    }
    this.localId = null;
    this.code = null;
    this.intent = null;
    this.reconnecting = false;
    this.turnCreds = null;
    this.turnReceivedAt = null;
    this.intentStartedAt = null;
    this.reconnectAttempt = 0;
    this.cb.onLeft(reason);
  }

  private async onServerEvent(env: ServerEnvelope): Promise<void> {
    switch (env.type) {
      case "room_created": {
        const { code, peerId, name, turn } = env.payload;
        this.localId = peerId;
        this.localName = name;
        this.names.set(peerId, name);
        this.code = code;
        this.iceServers = turnCredsToIceServers(turn ?? null);
        this.turnCreds = turn ?? null;
        this.turnReceivedAt = turn ? Date.now() : null;
        this.reconnectAttempt = 0;
        await this.becomeKeyOwner();
        this.installSelfVAD();
        // Sole-survivor reconnect: room got recreated under the same code,
        // capture survived, but presenterId still points at our prior local
        // ID. Refresh so the next peer_joined hands the joiner the screen
        // track and the matching announcement signal.
        if (this.capture) this.presenterId = peerId;
        if (this.reconnecting) {
          this.reconnecting = false;
          this.cb.onReconnected({ localId: peerId });
        } else {
          this.cb.onJoined({ code, localId: peerId, name });
        }
        return;
      }
      case "room_joined": {
        const { code, peerId, name, peers, turn } = env.payload;
        this.localId = peerId;
        this.localName = name;
        this.names.set(peerId, name);
        this.code = code;
        this.iceServers = turnCredsToIceServers(turn ?? null);
        this.turnCreds = turn ?? null;
        this.turnReceivedAt = turn ? Date.now() : null;
        this.reconnectAttempt = 0;
        for (const info of peers) {
          const p = this.addPeer(info);
          if (p) void p.start().catch((err) => console.error("peer.start failed", err));
        }
        this.installSelfVAD();
        // Reconnect-with-share: addPeer already re-installed the screen
        // tracks on every fresh peer; now re-announce via the screen signal
        // so the receiver tags the incoming audio as screen-audio. The
        // presenter ID also needs refreshing — it points at our prior
        // local ID, which the server has just replaced.
        if (this.capture) {
          this.presenterId = peerId;
          for (const info of peers) {
            this.relaySignal(info.id, { kind: "screen", on: true, streamId: this.capture.stream.id });
          }
        }
        if (this.reconnecting) {
          this.reconnecting = false;
          this.cb.onReconnected({ localId: peerId });
        } else {
          this.cb.onJoined({ code, localId: peerId, name });
        }
        // Existing peers will each send us the wrapped group key over signal.
        return;
      }
      case "peer_joined": {
        const { peerId, publicKey, supportsE2EE, name } = env.payload;
        const peer = this.addPeer({ id: peerId, publicKey, supportsE2EE, name });
        // Send the wrapped group key BEFORE starting the SDP exchange so the
        // joiner has the cipher in hand by the time encrypted audio frames
        // start arriving. Both signals go through the same WebSocket, so
        // sending the key first guarantees ordering. Only sent when the
        // remote announced E2EE support — otherwise the pair runs over
        // DTLS-SRTP only.
        if (peer && this.groupKeyRaw && supportsE2EE) {
          await this.sendKeyTo(peerId, publicKey);
        }
        // If we're already sharing, the joiner needs to know the screen
        // stream ID before the SDP offer arrives so the inbound audio
        // track gets classified as screen-audio. addPeer has already
        // queued the screen track on the peer; this signal precedes the
        // offer through the same WebSocket, so ordering holds.
        if (peer && this.capture) {
          this.relaySignal(peerId, { kind: "screen", on: true, streamId: this.capture.stream.id });
        }
        if (peer) {
          void peer.start().catch((err) => console.error("peer.start failed", err));
          playJoinTone();
        }
        return;
      }
      case "peer_left": {
        const { peerId } = env.payload;
        const p = this.peers.get(peerId);
        if (p) {
          p.close();
          this.peers.delete(peerId);
          this.iceRetried.delete(peerId);
          const name = this.names.get(peerId) ?? "";
          this.names.delete(peerId);
          // Drop chatAuthors entries authored by the departing peer so the
          // map doesn't grow without bound across long sessions. Their
          // historical messages stay rendered but become uneditable —
          // matching how P2P chat already behaves: only the original
          // author can edit, and they're gone.
          for (const [id, author] of this.chatAuthors)
            if (author === peerId) this.chatAuthors.delete(id);
          this.cb.onPeerRemoved(peerId, name);
          playLeaveTone();
        }
        if (this.presenterId === peerId) {
          this.presenterId = null;
          this.remoteScreens.delete(peerId);
          this.cb.onPresenterChanged(null, null);
        } else {
          this.remoteScreens.delete(peerId);
        }
        return;
      }
      case "peer_renamed": {
        const { peerId, name } = env.payload;
        if (peerId === this.localId) this.localName = name;
        this.names.set(peerId, name);
        this.cb.onPeerRenamed(peerId, name);
        return;
      }
      case "signal": {
        const { from, data } = env.payload;
        await this.dispatchSignal(from, data);
        return;
      }
      case "error": {
        this.cb.onError(env.payload.message ?? env.payload.code);
        return;
      }
    }
  }

  private async dispatchSignal(from: string, data: SignalData): Promise<void> {
    if (data.kind === "key") {
      await this.handleIncomingKey(data);
      return;
    }
    if (data.kind === "screen") {
      this.handleRemoteScreenSignal(from, data.on, data.streamId ?? null);
      return;
    }
    const peer = this.peers.get(from);
    if (!peer) {
      console.warn("signal from unknown peer", from);
      return;
    }
    await peer.handleSignal(data);
  }

  private handleRemoteScreenSignal(from: string, on: boolean, streamId: string | null): void {
    // Inform the peer first so its track-event classifier has the stream
    // ID by the time the renegotiation lands. Cleared on `on:false` so a
    // future remote audio sender (mic) doesn't get misclassified as
    // screen-audio by a stale match.
    const peer = this.peers.get(from);
    if (peer) peer.setRemoteScreenStreamId(on ? streamId : null);
    if (on) {
      // Takeover: a remote peer's share replaces whoever was presenting,
      // including ourselves. If we were sharing, stop our local capture
      // so we don't keep uploading video that nobody's looking at; the
      // remote becomes the visible presenter.
      if (this.presenterId === this.localId && this.capture) {
        this.stopShare();
      }
      this.presenterId = from;
      // Pass null stream — the actual MediaStream arrives on the track
      // event a moment later and triggers a second onPresenterChanged.
      this.cb.onPresenterChanged(from, this.remoteScreens.get(from) ?? null);
    } else {
      if (this.presenterId !== from) return;
      this.presenterId = null;
      this.remoteScreens.delete(from);
      this.cb.onPresenterChanged(null, null);
    }
  }

  // addPeer creates and registers a Peer for info. Returns null when the
  // peer is the local one or already known. The caller is responsible for
  // calling peer.start() after — that lets us interleave key delivery
  // between Peer construction and the SDP exchange.
  private addPeer(info: PeerInfo): Peer | null {
    if (info.id === this.localId) return null;
    if (this.peers.has(info.id)) return null;

    // Per-pair E2EE: only enabled when both sides report support. When
    // either side lacks the Insertable Streams API, the pair runs over
    // DTLS-SRTP only — still encrypted between the two browsers, just
    // without the per-call group-key layer.
    const useE2EE = isE2EEAvailable() && info.supportsE2EE;
    const peer = new Peer({
      localId: this.localId!,
      remoteId: info.id,
      iceServers: this.iceServers,
      useE2EE,
      callbacks: {
        sendSignal: (data) => this.relaySignal(info.id, data),
        onTrack: (stream) => this.cb.onRemoteStream(info.id, stream),
        onScreenTrack: (stream) => this.handleRemoteScreen(info.id, stream),
        onConnectionChange: (state) => this.handleConnectionChange(info.id, state),
        onChat: (id, body, ts) => {
          this.chatAuthors.set(id, info.id);
          const name = this.names.get(info.id) ?? info.name;
          this.cb.onChatMessage({ id, from: info.id, isSelf: false, name, body, ts });
        },
        onChatEdit: (id, body, editedTs) => {
          // Only honor edits authored by the peer whose channel they
          // arrived on. Unknown ids are silently dropped — they belong to
          // a message we never received (we joined after it was sent).
          if (this.chatAuthors.get(id) !== info.id) return;
          this.cb.onChatEdited({ id, body, editedTs });
        },
        onChatDelete: (id) => {
          if (this.chatAuthors.get(id) !== info.id) return;
          this.cb.onChatDeleted({ id });
        },
      },
    });
    peer.setLocalTrack(this.mic.outbound);
    if (this.cipher && useE2EE) peer.attachCipher(this.cipher);
    // If we're already presenting when this peer joins mid-call, hand them
    // the screen stream now so they get it on the very first SDP exchange.
    // The matching `screen` signal is sent by the caller (peer_joined or
    // room_joined handler) so the receiver knows which stream ID to tag
    // as screen-audio.
    if (this.capture) peer.setScreenTrack(this.capture.stream);
    this.peers.set(info.id, peer);
    this.names.set(info.id, info.name);
    this.cb.onPeerAdded(info.id, info.name);
    return peer;
  }

  // startShare prompts the user with the browser display picker, applies
  // the selected mode, and pushes the screen-share track to every peer.
  // Returns the capture handle on success; resolves null when the user
  // cancels. Throws on browser-level errors (permission denied, etc.).
  //
  // If another peer is already sharing, this takes over: our `screen on`
  // signal becomes their cue to stop and switch to viewing us.
  async startShare(mode: ShareMode): Promise<ShareCapture | null> {
    if (this.capture) return this.capture;
    let cap: ShareCapture;
    try {
      cap = await startShareCapture(mode);
    } catch (err) {
      // NotAllowedError is the user clicking "cancel" in the picker — not
      // a real failure; surface as a soft null so the UI can stay quiet.
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        return null;
      }
      throw err;
    }
    this.capture = cap;
    // The track ends when the user clicks the browser's "Stop sharing"
    // chrome bar. We need to mirror that into a normal stopShare so the
    // peers and UI stay in sync.
    cap.videoTrack.addEventListener("ended", () => {
      // The track may have already been removed by an explicit stopShare.
      if (this.capture === cap) void this.stopShare();
    });
    // Send the advisory signal BEFORE handing the track to the peer so the
    // receiver has remoteScreenStreamId set by the time the SDP renegotiation
    // arrives. WebSocket preserves order, and the SDP offer doesn't fly out
    // until negotiationneeded fires (microtasks later), so the signal lands
    // first in normal operation.
    for (const id of this.peers.keys()) {
      this.relaySignal(id, { kind: "screen", on: true, streamId: cap.stream.id });
      this.peers.get(id)!.setScreenTrack(cap.stream);
    }
    this.presenterId = this.localId;
    this.cb.onPresenterChanged(this.localId, cap.stream);
    return cap;
  }

  // stopShare removes the screen track from every peer and stops the
  // capture. Safe to call when not presenting (no-op).
  stopShare(): void {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    for (const id of this.peers.keys()) {
      this.relaySignal(id, { kind: "screen", on: false });
      this.peers.get(id)!.setScreenTrack(null);
    }
    stopShareCapture(cap);
    if (this.presenterId === this.localId) this.presenterId = null;
    this.cb.onPresenterChanged(null, null);
  }

  // currentPresenter returns the peer ID of whoever is currently sharing,
  // or null when nobody is. Used by the UI to gate the share button.
  currentPresenter(): string | null {
    return this.presenterId;
  }

  private handleRemoteScreen(peerId: string, stream: MediaStream | null): void {
    if (stream) {
      this.remoteScreens.set(peerId, stream);
      // Track-driven path: even without the advisory signal, ontrack tells
      // us who's presenting. Takeover semantics live in the signal handler;
      // here we just surface a stream we already accepted as presenter.
      // (If the signal hasn't arrived yet for some reason, we adopt the
      // first inbound stream as presenter — same first-write-wins fallback
      // as before.)
      if (!this.presenterId) {
        this.presenterId = peerId;
      }
      if (this.presenterId === peerId) {
        this.cb.onPresenterChanged(peerId, stream);
      }
      return;
    }
    this.remoteScreens.delete(peerId);
    if (this.presenterId === peerId) {
      this.presenterId = null;
      this.cb.onPresenterChanged(null, null);
    }
  }

  private handleConnectionChange(peerId: string, state: RTCPeerConnectionState): void {
    this.cb.onConnectionState(peerId, state);
    if (state === "failed") {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      if (this.iceRetried.has(peerId)) {
        // Already restarted once; let the UI show poor and wait for a
        // server-driven peer_left or user action.
        return;
      }
      this.iceRetried.add(peerId);
      void peer.restartIce();
    }
  }

  private relaySignal(to: string, data: SignalData): void {
    try {
      this.signaling.send({ type: "signal", payload: { to, data } });
    } catch (err) {
      console.warn("signal send failed", err);
    }
  }

  // becomeKeyOwner generates a fresh group key for a newly-created room
  // and installs the cipher locally. The key will be sent to each peer as
  // they join.
  private async becomeKeyOwner(): Promise<void> {
    if (!isE2EEAvailable()) {
      console.warn("Insertable Streams not available; falling back to DTLS-SRTP only");
      return;
    }
    this.groupKeyRaw = generateGroupKey();
    this.cipher = await GroupCipher.forKey(this.groupKeyRaw, (id, healthy) =>
      this.cb.onCipherHealth(id, healthy),
    );
  }

  private async sendKeyTo(remoteId: string, remotePub: string): Promise<void> {
    if (!this.groupKeyRaw) return;
    const wrap = await wrapGroupKey(this.keypair, remotePub, this.groupKeyRaw);
    const sig: SignalData = {
      kind: "key",
      epoch: 0, // v1 has one epoch per room; rotation is a future extension
      ephemeralPublicKey: wrap.ephemeralPublicKey,
      iv: wrap.iv,
      ciphertext: wrap.ciphertext,
    };
    this.relaySignal(remoteId, sig);
  }

  private async handleIncomingKey(data: SignalData & { kind: "key" }): Promise<void> {
    if (this.groupKeyRaw) return; // Already have it; ignore duplicates.
    if (!isE2EEAvailable()) return;
    try {
      const raw = await unwrapGroupKey(this.keypair, data.ephemeralPublicKey, data.iv, data.ciphertext);
      this.groupKeyRaw = raw;
      this.cipher = await GroupCipher.forKey(raw, (id, healthy) =>
        this.cb.onCipherHealth(id, healthy),
      );
      // Re-attach cipher only to peers that announced support. Mixed-mode
      // pairs (one side without Insertable Streams) stay on DTLS-SRTP.
      for (const peer of this.peers.values()) {
        if (peer.useE2EE) peer.attachCipher(this.cipher);
      }
    } catch (err) {
      console.error("group key unwrap failed", err);
    }
  }

  private installSelfVAD(): void {
    this.stopSelfVAD?.();
    this.stopSelfVAD = observeSpeaking(this.mic.raw, (speaking) => {
      if (this.localId) this.cb.onSpeakingChange(this.localId, speaking);
    });
  }

  // applyAdaptiveBitrate picks a per-peer Opus bitrate based on observed
  // inbound loss. We pick the worst-performing inbound link and degrade
  // outbound to match — we can't see the remote's outbound stats from here,
  // but loss is usually symmetric on the choke point. Receivers degrading
  // each other in lockstep is the failure mode to avoid; we damp by only
  // dropping after sustained loss and recovering slowly.
  applyAdaptiveBitrate(stats: Map<string, PeerStats>): void {
    let worstLoss = 0;
    for (const s of stats.values()) {
      if (typeof s.lossRate === "number" && Number.isFinite(s.lossRate)) {
        if (s.lossRate > worstLoss) worstLoss = s.lossRate;
      }
    }
    let target = 64_000;
    if (worstLoss >= 0.10) target = 24_000;
    else if (worstLoss >= 0.05) target = 32_000;
    else if (worstLoss >= 0.02) target = 48_000;
    for (const p of this.peers.values()) {
      p.setBitrate(target);
    }
  }

  async peerStats(): Promise<Map<string, PeerStats>> {
    const out = new Map<string, PeerStats>();
    const entries = await Promise.all(
      Array.from(this.peers, async ([id, peer]) => [id, await peer.stats()] as const),
    );
    for (const [id, s] of entries) out.set(id, s);
    return out;
  }

  // diagnostics returns a snapshot of room + per-peer connection state for
  // the user-facing diagnostics panel. Async because each peer's stats
  // report is async.
  async diagnostics(): Promise<Diagnostics> {
    const peerEntries = await Promise.all(
      Array.from(this.peers.values(), async (p) => p.diagnostics()),
    );
    const peers = peerEntries.map((d) => ({ ...d, name: this.names.get(d.id) ?? "" }));

    let status: Diagnostics["status"];
    if (!this.intent) {
      status = "left";
    } else if (this.reconnecting) {
      status = "reconnecting";
    } else if (
      this.localId !== null &&
      (this.peers.size === 0 ||
        peers.some((p) => p.connectionState === "connected"))
    ) {
      // Connected once we've joined and either we're alone or at least one
      // peer is fully up. The "alone in a room" case is uncommon but real
      // (room creator, before anyone joins) — we don't want to lie about it.
      status = "connected";
    } else {
      status = "connecting";
    }

    let ttlSecondsRemaining: number | null = null;
    if (this.turnCreds && this.turnReceivedAt) {
      const elapsed = (Date.now() - this.turnReceivedAt) / 1000;
      ttlSecondsRemaining = Math.max(0, this.turnCreds.ttl - elapsed);
    }

    return {
      capturedAt: Date.now(),
      status,
      intentStartedAt: this.intentStartedAt,
      reconnectAttempt: this.reconnectAttempt,
      code: this.code,
      localId: this.localId,
      ws: this.signaling.state(),
      turn: {
        received: this.turnCreds !== null,
        uris: this.turnCreds?.uris ?? [],
        ttlSecondsRemaining,
      },
      peers,
      local: {
        userAgent: navigator.userAgent,
        onLine: navigator.onLine,
      },
    };
  }

  // kickReconnect forcibly closes the websocket so the existing reconnect
  // machinery (onSignalingClosed → attemptReconnect) takes over. Used by
  // the diagnostics panel's Reconnect button when peers are stuck.
  // No-op when the room isn't active or the user already left.
  kickReconnect(): void {
    if (this.intent === null || this.leaving) return;
    try {
      this.signaling.close();
    } catch {
      // already closed; the close handler will still run
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
