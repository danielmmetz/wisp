// Room manages the local peer's mesh: signaling, per-remote-peer connections,
// the group key, and the wiring between mic capture and outbound senders.
//
// State machine:
//   idle → connecting → in-room → leaving → idle
// Reconnection is per-WebSocket: the underlying RTCPeerConnections survive
// short signaling drops as long as ICE is healthy. v1 implements one
// reconnect attempt with capped backoff before giving up.

import { observeSpeaking } from "./audio.ts";
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

export interface RoomCallbacks {
  onJoined: (info: { code: string; localId: string; name: string }) => void;
  onPeerAdded: (id: string, name: string) => void;
  onPeerRemoved: (id: string) => void;
  onPeerRenamed: (id: string, name: string) => void;
  onRemoteStream: (id: string, stream: MediaStream) => void;
  onSpeakingChange: (id: string, speaking: boolean) => void;
  onConnectionState: (id: string, state: RTCPeerConnectionState) => void;
  onLeft: (reason: string) => void;
  onError: (msg: string) => void;
}

export class Room {
  private cb: RoomCallbacks;
  private mic: MicCapture;
  private signaling: SignalingClient;
  private keypair!: EphemeralKeypair;
  private peers = new Map<string, Peer>();
  private localId: string | null = null;
  private code: string | null = null;
  private iceServers: RTCIceServer[] = [];
  private cipher: GroupCipher | null = null;
  private groupKeyRaw: Uint8Array | null = null;
  private stopSelfVAD: (() => void) | null = null;

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
    await this.dialAndHandshake(async () => {
      this.signaling.send({
        type: "create_room",
        payload: { publicKey: this.keypair.publicKey, supportsE2EE: isE2EEAvailable(), name },
      });
    });
  }

  // join dials the signaling server with an existing room code.
  async join(code: string, name: string): Promise<void> {
    await this.dialAndHandshake(async () => {
      this.signaling.send({
        type: "join_room",
        payload: { code, publicKey: this.keypair.publicKey, supportsE2EE: isE2EEAvailable(), name },
      });
    });
  }

  // rename sends a rename request; the server broadcasts peer_renamed back
  // (including to this client) so all views advance from the same source.
  rename(name: string): void {
    try {
      this.signaling.send({ type: "rename", payload: { name } });
    } catch (err) {
      console.warn("rename send failed", err);
    }
  }

  leave(): void {
    try {
      this.signaling.send({ type: "leave_room", payload: {} });
    } catch {
      // socket may already be closed
    }
    this.teardown("user left");
  }

  private async dialAndHandshake(send: () => Promise<void>): Promise<void> {
    this.keypair = await generateEphemeralKeypair();
    await this.signaling.connect(signalingURL());
    await send();
  }

  private onSignalingClosed(): void {
    if (this.localId !== null) {
      this.teardown("signaling closed");
    }
  }

  private teardown(reason: string): void {
    for (const p of this.peers.values()) p.close();
    this.peers.clear();
    this.stopSelfVAD?.();
    this.stopSelfVAD = null;
    this.signaling.close();
    if (this.groupKeyRaw) this.groupKeyRaw.fill(0);
    this.groupKeyRaw = null;
    this.cipher = null;
    this.localId = null;
    this.code = null;
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
        this.cb.onJoined({ code, localId: peerId, name });
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
        this.cb.onJoined({ code, localId: peerId, name });
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
        if (peer) void peer.start().catch((err) => console.error("peer.start failed", err));
        return;
      }
      case "peer_left": {
        const { peerId } = env.payload;
        const p = this.peers.get(peerId);
        if (p) {
          p.close();
          this.peers.delete(peerId);
          this.cb.onPeerRemoved(peerId);
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
        onConnectionChange: (state) => this.cb.onConnectionState(info.id, state),
      },
    });
    peer.setLocalTrack(this.mic.outbound);
    if (this.cipher && useE2EE) peer.attachCipher(this.cipher);
    this.peers.set(info.id, peer);
    this.cb.onPeerAdded(info.id, info.name);
    return peer;
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
    this.cipher = await GroupCipher.forKey(this.groupKeyRaw);
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
      this.cipher = await GroupCipher.forKey(raw);
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

  async peerStats(): Promise<Map<string, PeerStats>> {
    const out = new Map<string, PeerStats>();
    const entries = await Promise.all(
      Array.from(this.peers, async ([id, peer]) => [id, await peer.stats()] as const),
    );
    for (const [id, s] of entries) out.set(id, s);
    return out;
  }
}
