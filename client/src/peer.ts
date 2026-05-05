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

const OPUS_BITRATE_DEFAULT = 48_000;
// SDP RED payload type. 63 is the de-facto value used by Chromium when it
// negotiates RED for audio; we reuse it so peers that already understand
// browser-side RED (Chrome 102+) interop without surprises. The munge is
// strictly additive — if the remote doesn't accept RED, the standard offer/
// answer renegotiation will still leave Opus working.
const RED_PT = 63;

export type PeerTransport = "direct" | "relayed";

export interface PeerStats {
  rttMs?: number;
  packetsLost?: number;
  packetsRecv?: number;
  // lossRate is the inbound loss fraction on the last sampling window
  // (0..1). NaN when no samples are available yet.
  lossRate?: number;
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
  // onChat fires when a chat message arrives on the data channel. body has
  // already been validated as a string. ts is the sender's epoch ms; not
  // trusted for ordering, just shown as the timestamp of the message.
  onChat?: (body: string, ts: number) => void;
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
  private chatChannel: RTCDataChannel | null = null;
  // Receivers that fired ontrack before the cipher was available; wired
  // by attachCipher when the group key arrives.
  private pendingReceivers: RTCRtpReceiver[] = [];
  // Buffer ICE candidates that arrived before remoteDescription is set.
  private pendingIce: RTCIceCandidateInit[] = [];
  // Snapshot of last-seen inbound counts; used to compute a windowed loss
  // rate without leaking cumulative-since-start values into the UI.
  private lastLost = 0;
  private lastRecv = 0;
  // Bitrate currently applied on the outbound sender. We only call
  // setParameters when the value actually changes — getParameters/setParameters
  // round-trips are cheap but not free.
  private currentBitrate = OPUS_BITRATE_DEFAULT;

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
    // The answerer waits for the offerer's data channel; the offerer creates
    // it in start() before the SDP exchange so the channel ends up in the
    // first offer (no extra negotiation round-trip).
    this.pc.addEventListener("datachannel", (ev) => {
      if (ev.channel.label === "chat") this.attachChatChannel(ev.channel);
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
    // Apply the default bitrate immediately. setParameters can race the
    // first negotiation on some builds, so we swallow errors and let the
    // adaptive loop retry on the next stats tick.
    this.applyBitrate(this.currentBitrate);
    // Mark the audio sender as high-priority so DSCP markings (when the OS
    // honors them) and browser-internal scheduling favor voice over any
    // future data channels.
    try {
      const params = this.localSender.getParameters();
      if (params.encodings && params.encodings[0]) {
        const enc = params.encodings[0] as RTCRtpEncodingParameters & { networkPriority?: string };
        enc.priority = "high";
        enc.networkPriority = "high";
        void this.localSender.setParameters(params);
      }
    } catch {
      /* setParameters may not yet be ready; harmless */
    }
  }

  // setBitrate updates the outbound encoder's maxBitrate. Caller picks the
  // value based on observed loss/RTT.
  setBitrate(bps: number): void {
    if (bps === this.currentBitrate) return;
    this.currentBitrate = bps;
    this.applyBitrate(bps);
  }

  private applyBitrate(bps: number): void {
    const sender = this.localSender;
    if (!sender) return;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0]!.maxBitrate = bps;
      void sender.setParameters(params).catch(() => {/* race with negotiation */});
    } catch {
      /* harmless; will retry on next tick */
    }
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
    // Chat data channel must be created before the offer so SCTP is in the
    // first SDP. Reliable + ordered: the room is small and chat throughput
    // is trivial, so reordering or loss isn't worth tolerating here.
    this.attachChatChannel(this.pc.createDataChannel("chat", { ordered: true }));
    await this.offer({});
  }

  // sendChat dispatches a single chat message to this peer over the chat
  // data channel. Returns false when the channel isn't open yet — the room
  // layer can decide whether to skip or buffer.
  sendChat(body: string, ts: number): boolean {
    const dc = this.chatChannel;
    if (!dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify({ kind: "chat", body, ts }));
      return true;
    } catch (err) {
      console.warn("chat send failed", err);
      return false;
    }
  }

  private attachChatChannel(dc: RTCDataChannel): void {
    this.chatChannel = dc;
    dc.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object") return;
      const m = parsed as { kind?: unknown; body?: unknown; ts?: unknown };
      if (m.kind !== "chat") return;
      if (typeof m.body !== "string") return;
      const ts = typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : Date.now();
      this.cb.onChat?.(m.body, ts);
    });
  }

  // restartIce regenerates ICE candidates without rebuilding the PC. Only
  // the offerer initiates; the answerer follows naturally via handleSignal.
  async restartIce(): Promise<void> {
    if (!this.local.isOfferer) return;
    try {
      await this.offer({ iceRestart: true });
    } catch (err) {
      console.warn("ICE restart failed", err);
    }
  }

  private async offer(opts: { iceRestart?: boolean }): Promise<void> {
    const offer = await this.pc.createOffer(opts);
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
    let cumLost = 0;
    let cumRecv = 0;
    stats.forEach((rep) => {
      if (rep.type === "candidate-pair" && rep.state === "succeeded" && rep.nominated) {
        if (typeof rep.currentRoundTripTime === "number") {
          out.rttMs = rep.currentRoundTripTime * 1000;
        }
        localCandidateId = rep.localCandidateId;
        remoteCandidateId = rep.remoteCandidateId;
      }
      if (rep.type === "inbound-rtp" && rep.kind === "audio") {
        if (typeof rep.packetsLost === "number") cumLost = rep.packetsLost;
        if (typeof rep.packetsReceived === "number") cumRecv = rep.packetsReceived;
      }
    });
    out.packetsLost = cumLost;
    out.packetsRecv = cumRecv;
    // Windowed loss rate: divide deltas since the last sample. The first
    // sample after construction always reads the full cumulative count
    // (lastLost/lastRecv default to 0), so we report NaN until the second
    // sample to avoid spiking the indicator on join.
    const dLost = cumLost - this.lastLost;
    const dRecv = cumRecv - this.lastRecv;
    const dTotal = dLost + dRecv;
    if (this.lastRecv > 0 && dTotal > 0) {
      out.lossRate = dLost / dTotal;
    }
    this.lastLost = cumLost;
    this.lastRecv = cumRecv;
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

  connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
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

// munge tweaks the SDP per proposal § Codec/transport. We do two passes:
//
//   1. Append/replace Opus fmtp (DTX, FEC, bitrate cap).
//   2. Insert a RED payload type that wraps Opus, ahead of Opus in the
//      m=audio line, so the encoder negotiates RED redundancy. RFC 2198 RED
//      gives us cheap recovery from single-packet loss bursts that Opus
//      inband FEC alone can't always patch (FEC carries the previous frame
//      at lower quality; RED carries one or more full prior payloads).
//
// Both passes are best-effort: if the SDP shape is unfamiliar (different
// browser/version) we leave the input unchanged for that pass.
function munge(sdp: string | undefined): string | undefined {
  if (!sdp) return sdp;
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
  const wantParams = `minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=${OPUS_BITRATE_DEFAULT}`;
  let touched = false;
  let out = lines.map((line) => {
    if (line.startsWith(`a=fmtp:${opusPt} `)) {
      touched = true;
      return `a=fmtp:${opusPt} ${wantParams}`;
    }
    return line;
  });
  if (!touched) {
    const idx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt} opus/48000`));
    if (idx >= 0) {
      out.splice(idx + 1, 0, `a=fmtp:${opusPt} ${wantParams}`);
    }
  }

  // Add RED in front of Opus for FEC redundancy. Skip if RED is already
  // declared on a different PT or the RED_PT slot is taken — both mean the
  // browser already negotiated something; don't fight it.
  const redPtStr = String(RED_PT);
  const hasOurRed = out.some((l) => l.startsWith(`a=rtpmap:${redPtStr} red/48000`));
  const slotTaken = !hasOurRed && out.some((l) => l.startsWith(`a=rtpmap:${redPtStr} `));
  const hasOtherRed = out.some((l) => /^a=rtpmap:\d+ red\/48000/i.test(l) && !l.startsWith(`a=rtpmap:${redPtStr} `));
  if (!hasOurRed && !slotTaken && !hasOtherRed) {
    const audioMIdx = out.findIndex((l) => l.startsWith("m=audio "));
    const opusRtpIdx = out.findIndex((l) => l.startsWith(`a=rtpmap:${opusPt} opus/48000`));
    if (audioMIdx >= 0 && opusRtpIdx >= 0) {
      out = patchAudioMLine(out, audioMIdx, opusPt, redPtStr);
      // Insert rtpmap + fmtp for RED right after the existing Opus rtpmap.
      out.splice(opusRtpIdx + 1, 0, `a=rtpmap:${redPtStr} red/48000/2`);
      out.splice(opusRtpIdx + 2, 0, `a=fmtp:${redPtStr} ${opusPt}/${opusPt}`);
    }
  }

  return out.join("\r\n");
}

// patchAudioMLine moves redPt to the front of the audio m-line's PT list
// (right after the existing PTs in the leading fields), so the offerer
// expresses preference for RED over raw Opus. We don't strip the Opus PT —
// RED falls back to plain Opus if the remote doesn't accept it.
function patchAudioMLine(lines: string[], idx: number, opusPt: string, redPt: string): string[] {
  const m = lines[idx]!;
  const parts = m.split(" ");
  // m=audio <port> <proto> <pt1> <pt2> ...
  if (parts.length < 4) return lines;
  const head = parts.slice(0, 3);
  const pts = parts.slice(3).filter((p) => p !== redPt);
  const opusIdx = pts.indexOf(opusPt);
  if (opusIdx < 0) return lines;
  pts.splice(opusIdx, 0, redPt);
  const next = [...lines];
  next[idx] = [...head, ...pts].join(" ");
  return next;
}
