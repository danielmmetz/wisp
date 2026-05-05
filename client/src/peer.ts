// Peer is one RTCPeerConnection between us and one other peer in the room.
//
// Glare-free offering: when both peers exist, the one with the lexicographically
// smaller peer ID is the offerer. The other side receives the offer and
// answers. ICE candidates flow through the signaling channel in both directions.
//
// E2EE: GroupCipher (when supplied) wires encryption into the local sender
// and decryption into the remote receiver. When the cipher is not yet
// available (the group key wrap hasn't arrived), the connection still
// establishes and audio flows under DTLS-SRTP only; the cipher can be
// installed later via attachCipher.

import type { GroupCipher } from "./e2ee.ts";
import type { TurnCreds, SignalData } from "./wire.ts";

const OPUS_BITRATE_BPS = 48_000;

export type PeerTransport = "direct" | "relayed";

export interface PeerStats {
  rttMs?: number;
  packetsLost?: number;
  packetsRecv?: number;
  transport?: PeerTransport;
}

export interface PeerCallbacks {
  // sendSignal forwards a SignalData payload to the remote peer through the
  // signaling server. Implementer encodes and dispatches.
  sendSignal: (data: SignalData) => void;
  // onTrack receives the remote audio MediaStream so the room layer can
  // attach it to an <audio> element.
  onTrack: (stream: MediaStream) => void;
  // onConnectionChange surfaces ICE/connection-state transitions for the
  // quality indicator.
  onConnectionChange: (state: RTCPeerConnectionState) => void;
}

export class Peer {
  readonly remoteId: string;
  readonly local: { id: string; isOfferer: boolean };
  // useE2EE is true when both sides reported Insertable Streams support;
  // when false the pair runs over DTLS-SRTP only and the cipher transforms
  // are no-ops.
  readonly useE2EE: boolean;
  private pc: RTCPeerConnection;
  private cb: PeerCallbacks;
  private cipher: GroupCipher | null = null;
  private localSender: RTCRtpSender | null = null;
  private senderWired = false;
  // Receivers that fired ontrack before the cipher was available; wired
  // by attachCipher when the group key arrives.
  private pendingReceivers: RTCRtpReceiver[] = [];
  // Buffer ICE candidates that arrived before remoteDescription is set.
  private pendingIce: RTCIceCandidateInit[] = [];

  constructor(opts: {
    localId: string;
    remoteId: string;
    iceServers: RTCIceServer[];
    useE2EE: boolean;
    callbacks: PeerCallbacks;
  }) {
    this.remoteId = opts.remoteId;
    this.local = { id: opts.localId, isOfferer: opts.localId < opts.remoteId };
    this.useE2EE = opts.useE2EE;
    this.cb = opts.callbacks;

    const config: RTCConfiguration = {
      iceServers: opts.iceServers,
      bundlePolicy: "max-bundle",
    };
    // Insertable Streams must be opted into at PC construction time. Only
    // request it when this peer-pair is going to use the cipher transforms;
    // otherwise the connection runs as a normal WebRTC PC.
    if (opts.useE2EE) {
      (config as RTCConfiguration & { encodedInsertableStreams?: boolean }).encodedInsertableStreams = true;
    }

    this.pc = new RTCPeerConnection(config);
    this.pc.addEventListener("icecandidate", (ev) => {
      if (!ev.candidate) return;
      this.cb.sendSignal({ kind: "ice", candidate: ev.candidate.toJSON() });
    });
    this.pc.addEventListener("track", (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (this.useE2EE) {
        if (this.cipher) {
          this.cipher.wireReceiver(ev.receiver, this.remoteId);
        } else {
          // Cipher not yet available — buffer this receiver and wire it when
          // attachCipher runs. Calling createEncodedStreams now (with no
          // cipher) and again later would throw "already created".
          this.pendingReceivers.push(ev.receiver);
        }
      }
      this.cb.onTrack(stream);
    });
    this.pc.addEventListener("connectionstatechange", () => {
      this.cb.onConnectionChange(this.pc.connectionState);
    });
  }

  // setLocalTrack adds (or replaces) the outbound microphone track.
  setLocalTrack(track: MediaStreamTrack): void {
    if (this.localSender) {
      void this.localSender.replaceTrack(track);
      return;
    }
    const stream = new MediaStream([track]);
    this.localSender = this.pc.addTrack(track, stream);
    this.tryWireSender();
  }

  // attachCipher installs the GroupCipher and wires any sender/receivers
  // that were waiting for it. No-op when this peer-pair doesn't use E2EE.
  attachCipher(cipher: GroupCipher): void {
    if (!this.useE2EE) return;
    this.cipher = cipher;
    this.tryWireSender();
    const drained = this.pendingReceivers;
    this.pendingReceivers = [];
    for (const r of drained) cipher.wireReceiver(r, this.remoteId);
  }

  // tryWireSender wires the sender exactly once, when both the sender and
  // the cipher exist. Calling RTCRtpSender.createEncodedStreams twice
  // throws InvalidStateError, so the senderWired flag guards the second
  // attempt. Receivers can't use this pattern because their identity is
  // bound to ontrack, not the time the sender was added.
  private tryWireSender(): void {
    if (this.senderWired) return;
    if (!this.cipher || !this.localSender) return;
    this.cipher.wireSender(this.localSender, this.local.id);
    this.senderWired = true;
  }

  // start kicks off the SDP exchange for the offerer side. The answerer
  // does nothing until handleSignal sees the offer.
  async start(): Promise<void> {
    if (!this.local.isOfferer) return;
    const offer = await this.pc.createOffer();
    offer.sdp = munge(offer.sdp);
    await this.pc.setLocalDescription(offer);
    if (this.pc.localDescription) {
      this.cb.sendSignal({ kind: "sdp", description: this.pc.localDescription.toJSON() });
    }
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (data.kind === "sdp") {
      const desc = data.description;
      if (desc.type === "offer") {
        await this.pc.setRemoteDescription(desc);
        await this.flushPendingIce();
        const answer = await this.pc.createAnswer();
        answer.sdp = munge(answer.sdp);
        await this.pc.setLocalDescription(answer);
        if (this.pc.localDescription) {
          this.cb.sendSignal({ kind: "sdp", description: this.pc.localDescription.toJSON() });
        }
      } else if (desc.type === "answer") {
        await this.pc.setRemoteDescription(desc);
        await this.flushPendingIce();
      }
      return;
    }
    if (data.kind === "ice") {
      if (!this.pc.remoteDescription) {
        this.pendingIce.push(data.candidate);
        return;
      }
      try {
        await this.pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn("addIceCandidate failed", err);
      }
    }
  }

  async stats(): Promise<PeerStats> {
    const out: PeerStats = {};
    const stats = await this.pc.getStats();
    let localCandidateId: string | undefined;
    let remoteCandidateId: string | undefined;
    stats.forEach((rep) => {
      if (rep.type === "candidate-pair" && rep.state === "succeeded" && rep.nominated) {
        if (typeof rep.currentRoundTripTime === "number") {
          out.rttMs = rep.currentRoundTripTime * 1000;
        }
        localCandidateId = rep.localCandidateId;
        remoteCandidateId = rep.remoteCandidateId;
      }
      if (rep.type === "inbound-rtp" && rep.kind === "audio") {
        out.packetsLost = rep.packetsLost;
        out.packetsRecv = rep.packetsReceived;
      }
    });
    // The selected pair tells us how the media is actually flowing. If either
    // side's candidate is "relay" the path goes through TURN; otherwise it's
    // a direct host/srflx/prflx pairing between the two browsers.
    if (localCandidateId || remoteCandidateId) {
      const local = localCandidateId ? stats.get(localCandidateId) : undefined;
      const remote = remoteCandidateId ? stats.get(remoteCandidateId) : undefined;
      const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
      out.transport = relayed ? "relayed" : "direct";
    }
    return out;
  }

  close(): void {
    this.pc.close();
  }

  private async flushPendingIce(): Promise<void> {
    const buffered = this.pendingIce;
    this.pendingIce = [];
    for (const c of buffered) {
      try {
        await this.pc.addIceCandidate(c);
      } catch (err) {
        console.warn("buffered addIceCandidate failed", err);
      }
    }
  }
}

// turnCredsToIceServers converts the Cloudflare TURN creds wire shape into
// the RTCIceServer array expected by RTCPeerConnection.
export function turnCredsToIceServers(creds: TurnCreds | null | undefined): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.cloudflare.com:3478" }];
  if (!creds) return servers;
  servers.push({
    urls: creds.uris,
    username: creds.username,
    credential: creds.credential,
  });
  return servers;
}

// munge tweaks the SDP to set Opus parameters per proposal § Codec/transport.
// Anything we can't set via RTCRtpSender params (DTX, FEC, useinbandfec,
// usedtx, application=voip-style hint) we set here. Best-effort: if the SDP
// shape changes between browser versions we keep what we recognize.
function munge(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
  // Append (or set) Opus fmtp parameters.
  const lines = sdp.split("\r\n");
  let opusPt: string | null = null;
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+) opus\/48000/i);
    if (m) {
      opusPt = m[1] ?? null;
      break;
    }
  }
  if (!opusPt) return sdp;
  const wantParams = `minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=${OPUS_BITRATE_BPS}`;
  let touched = false;
  const out = lines.map((line) => {
    if (line.startsWith(`a=fmtp:${opusPt} `)) {
      touched = true;
      return `a=fmtp:${opusPt} ${wantParams}`;
    }
    return line;
  });
  if (!touched) {
    // Insert a fmtp line right after the rtpmap line for opus.
    const idx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt} opus/48000`));
    if (idx >= 0) {
      out.splice(idx + 1, 0, `a=fmtp:${opusPt} ${wantParams}`);
    }
  }
  return out.join("\r\n");
}
