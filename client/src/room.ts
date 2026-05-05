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
import { Peer, turnCredsToIceServers, type PeerStats } from "./peer.ts";
import { SignalingClient, signalingURL } from "./signaling.ts";
import type { MicCapture } from "./audio.ts";
import type { ServerEnvelope, SignalData, TurnCreds, PeerInfo } from "./wire.ts";

// Reconnect backoff: 0.5s, 1s, 2s, 4s, 8s, 16s, 30s. Cap at 30s and stop
// after MAX_RECONNECT_ATTEMPTS attempts so we don't spin forever for a
// truly-dead network.
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 16000, 30000];
const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export interface RoomCallbacks {
  onJoined: (info: { code: string; localId: string; name: string }) => void;
  onPeerAdded: (id: string, name: string) => void;
  onPeerRemoved: (id: string) => void;
  onPeerRenamed: (id: string, name: string) => void;
  onRemoteStream: (id: string, stream: MediaStream) => void;
  onSpeakingChange: (id: string, speaking: boolean) => void;
  onConnectionState: (id: string, state: RTCPeerConnectionState) => void;
  // onCipherHealth fires when sustained decrypt failures cross a threshold
  // (healthy=false) and again when decryption recovers (healthy=true).
  onCipherHealth: (id: string, healthy: boolean) => void;
  onLeft: (reason: string) => void;
  onError: (msg: string) => void;
  // onReconnecting/onReconnected let the UI surface "trying to reconnect..."
  // without conflating it with a final disconnect.
  onReconnecting: (attempt: number) => void;
  onReconnected: () => void;
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
  // iceRetried tracks per-peer ICE-restart attempts so we don't loop on a
  // truly-dead path.
  private iceRetried = new Set<string>();
  private localId: string | null = null;
  private code: string | null = null;
  private iceServers: RTCIceServer[] = [];
  private cipher: GroupCipher | null = null;
  private groupKeyRaw: Uint8Array | null = null;
  private stopSelfVAD: (() => void) | null = null;
  // intent records what we did to enter the room so we can replay it on
  // reconnect. Cleared by leave/teardown.
  private intent: JoinIntent | null = null;
  private leaving = false;
  private reconnecting = false;

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
    this.cipher = null;
    if (this.groupKeyRaw) this.groupKeyRaw.fill(0);
    this.groupKeyRaw = null;
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
    // Out of attempts — give up.
    this.reconnecting = false;
    this.cb.onLeft("reconnect failed");
    this.intent = null;
  }

  private teardown(reason: string): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.iceRetried.clear();
    this.stopSelfVAD?.();
    this.stopSelfVAD = null;
    this.signaling.close();
    if (this.groupKeyRaw) this.groupKeyRaw.fill(0);
    this.groupKeyRaw = null;
    this.cipher = null;
    this.localId = null;
    this.code = null;
    this.intent = null;
    this.reconnecting = false;
    this.cb.onLeft(reason);
  }

  private async onServerEvent(env: ServerEnvelope): Promise<void> {
    switch (env.type) {
      case "room_created": {
        const { code, peerId, name, turn } = env.payload;
        this.localId = peerId;
        this.code = code;
        this.iceServers = turnCredsToIceServers(turn ?? null);
        await this.becomeKeyOwner();
        this.installSelfVAD();
        if (this.reconnecting) {
          this.reconnecting = false;
          this.cb.onReconnected();
        } else {
          this.cb.onJoined({ code, localId: peerId, name });
        }
        return;
      }
      case "room_joined": {
        const { code, peerId, name, peers, turn } = env.payload;
        this.localId = peerId;
        this.code = code;
        this.iceServers = turnCredsToIceServers(turn ?? null);
        for (const info of peers) {
          const p = this.addPeer(info);
          if (p) void p.start().catch((err) => console.error("peer.start failed", err));
        }
        this.installSelfVAD();
        if (this.reconnecting) {
          this.reconnecting = false;
          this.cb.onReconnected();
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
          this.cb.onPeerRemoved(peerId);
          playLeaveTone();
        }
        return;
      }
      case "peer_renamed": {
        const { peerId, name } = env.payload;
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
    const peer = this.peers.get(from);
    if (!peer) {
      console.warn("signal from unknown peer", from);
      return;
    }
    await peer.handleSignal(data);
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
        onConnectionChange: (state) => this.handleConnectionChange(info.id, state),
      },
    });
    peer.setLocalTrack(this.mic.outbound);
    if (this.cipher && useE2EE) peer.attachCipher(this.cipher);
    this.peers.set(info.id, peer);
    this.cb.onPeerAdded(info.id, info.name);
    return peer;
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
