// Peer is one RTCPeerConnection between us and one other peer in the room.
//
// Initial offerer: the side with the lexicographically smaller peer ID
// creates the chat data channel and the first offer. After that, either
// side can trigger renegotiation (e.g. by adding/removing a screen-share
// track) and we run the standard "perfect negotiation" pattern to handle
// glare: the impolite peer (the original offerer) ignores colliding offers,
// and the polite peer (the answerer) rolls back its in-flight offer to
// accept the remote one.
//
// E2EE: GroupCipher (when supplied) wires encryption into the local sender
// and decryption into the remote receiver. When the cipher is not yet
// available (the group key wrap hasn't arrived), the connection still
// establishes and audio flows under DTLS-SRTP only; the cipher can be
// installed later via attachCipher. Each track (audio mic, screen share)
// gets its own track-tag in the IV so a peer's senders never collide.

import type { GroupCipher } from "./e2ee.ts";
import type { TurnCreds, SignalData } from "./wire.ts";

const OPUS_BITRATE_DEFAULT = 48_000;
// Screen-share max outbound bitrate. 1080p text content is essentially free
// (the encoder drops to near-zero with contentHint=text on a static page);
// 1080p motion content tops out around here. We let WebRTC's congestion
// control pull below this value when the network is constrained — this is
// the ceiling, not the target.
const SCREEN_BITRATE_MAX = 2_500_000;
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
  // onScreenTrack receives the remote screen-share MediaStream when the
  // peer starts sharing, and null when the corresponding video track ends.
  // Optional — peers that don't render screen share can leave it unset.
  onScreenTrack?: (stream: MediaStream | null) => void;
  // onConnectionChange surfaces ICE/connection-state transitions for the
  // quality indicator.
  onConnectionChange: (state: RTCPeerConnectionState) => void;
  // onChat fires when a chat message arrives on the data channel. body has
  // already been validated as a string. ts is the sender's epoch ms; not
  // trusted for ordering, just shown as the timestamp of the message.
  onChat?: (body: string, ts: number) => void;
}

type RxKind = "audio" | "screen" | "screen-audio";

interface PendingReceiver {
  receiver: RTCRtpReceiver;
  kind: RxKind;
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
  private screenSender: RTCRtpSender | null = null;
  private screenSenderWired = false;
  private screenAudioSender: RTCRtpSender | null = null;
  private screenAudioSenderWired = false;
  private remoteScreenStream: MediaStream | null = null;
  // remoteScreenStreamId is the MediaStream ID the remote presenter
  // announced in their `screen` signal. Audio receivers whose stream ID
  // matches get the "screen-audio" track tag for IV derivation; without
  // this hint, a second inbound audio track would be classified as a
  // second mic and reuse the audio IV space.
  private remoteScreenStreamId: string | null = null;
  private chatChannel: RTCDataChannel | null = null;
  // Receivers that fired ontrack before the cipher was available; wired
  // by attachCipher when the group key arrives. Stored with their track
  // kind so wireReceiver gets the right tag.
  private pendingReceivers: PendingReceiver[] = [];
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
  // Perfect negotiation state. The original offerer is "impolite" and
  // ignores colliding offers; the answerer is "polite" and rolls back its
  // in-flight offer to accept a remote one.
  private makingOffer = false;
  // ignoreOffer is set when an incoming offer was discarded due to glare;
  // the matching ICE candidates that follow get tolerated rather than
  // surfaced as errors.
  private ignoreOffer = false;

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
      let kind: RxKind;
      if (ev.track.kind === "video") {
        kind = "screen";
      } else if (this.remoteScreenStreamId && stream.id === this.remoteScreenStreamId) {
        kind = "screen-audio";
      } else {
        kind = "audio";
      }
      if (this.useE2EE) {
        if (this.cipher) {
          this.cipher.wireReceiver(ev.receiver, this.remoteId, kind);
        } else {
          // Cipher not yet available — buffer this receiver and wire it when
          // attachCipher runs. Calling createEncodedStreams now (with no
          // cipher) and again later would throw "already created".
          this.pendingReceivers.push({ receiver: ev.receiver, kind });
        }
      }
      if (kind === "screen") {
        this.remoteScreenStream = stream;
        // When the remote stops sharing, the video track ends. Clear the
        // tile so the UI can hide the presenter view.
        ev.track.addEventListener("ended", () => {
          if (this.remoteScreenStream === stream) {
            this.remoteScreenStream = null;
            this.cb.onScreenTrack?.(null);
          }
        });
        this.cb.onScreenTrack?.(stream);
      } else if (kind === "screen-audio") {
        // The audio track belongs to the same MediaStream as the screen
        // video; ev.streams[0] is shared, so the stream object the UI
        // already has now carries audio too. Surface the stream if we
        // haven't yet (audio-first arrival is rare but possible).
        if (!this.remoteScreenStream) {
          this.remoteScreenStream = stream;
          this.cb.onScreenTrack?.(stream);
        }
      } else {
        this.cb.onTrack(stream);
      }
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
    // negotiationneeded fires after addTrack/removeTrack when the SDP needs
    // refreshing. The initial offer (chat data channel) is still triggered
    // explicitly from start() to keep ordering predictable; subsequent
    // changes (screen-share toggle) come through here. The polite peer (the
    // answerer) generates an offer too, which the impolite peer (the
    // offerer) ignores on collision per perfect-negotiation rules.
    this.pc.addEventListener("negotiationneeded", () => {
      void this.runOffer({});
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
    this.tryWireScreenSender();
    this.tryWireScreenAudioSender();
    const drained = this.pendingReceivers;
    this.pendingReceivers = [];
    for (const pr of drained) cipher.wireReceiver(pr.receiver, this.remoteId, pr.kind);
  }

  // tryWireSender wires the sender exactly once, when both the sender and
  // the cipher exist. Calling RTCRtpSender.createEncodedStreams twice
  // throws InvalidStateError, so the senderWired flag guards the second
  // attempt. Receivers can't use this pattern because their identity is
  // bound to ontrack, not the time the sender was added.
  private tryWireSender(): void {
    if (this.senderWired) return;
    if (!this.cipher || !this.localSender) return;
    this.cipher.wireSender(this.localSender, this.local.id, "audio");
    this.senderWired = true;
  }

  private tryWireScreenSender(): void {
    if (this.screenSenderWired) return;
    if (!this.cipher || !this.screenSender) return;
    this.cipher.wireSender(this.screenSender, this.local.id, "screen");
    this.screenSenderWired = true;
  }

  private tryWireScreenAudioSender(): void {
    if (this.screenAudioSenderWired) return;
    if (!this.cipher || !this.screenAudioSender) return;
    this.cipher.wireSender(this.screenAudioSender, this.local.id, "screen-audio");
    this.screenAudioSenderWired = true;
  }

  // setRemoteScreenStreamId tells this peer which inbound MediaStream the
  // remote will use for their screen share. Drives audio-track classification
  // in the track event listener so screen-audio frames get the right IV tag.
  setRemoteScreenStreamId(id: string | null): void {
    this.remoteScreenStreamId = id;
  }

  // setScreenTrack adds (or replaces) the outbound screen-share tracks (one
  // video, optionally one audio for system-audio capture), or removes both
  // when stream is null. Both senders ride the same MediaStream so the
  // remote sees them grouped — the receiver looks up the stream ID it was
  // told about via the screen signal and tags audio frames accordingly.
  setScreenTrack(stream: MediaStream | null): void {
    if (stream === null) {
      if (this.screenSender) {
        try { this.pc.removeTrack(this.screenSender); } catch (err) { console.warn("removeTrack failed", err); }
        this.screenSender = null;
        this.screenSenderWired = false;
      }
      if (this.screenAudioSender) {
        try { this.pc.removeTrack(this.screenAudioSender); } catch (err) { console.warn("removeTrack failed", err); }
        this.screenAudioSender = null;
        this.screenAudioSenderWired = false;
      }
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (!video) return;
    const audio = stream.getAudioTracks()[0] ?? null;

    // Video sender — add or replace.
    if (this.screenSender) {
      void this.screenSender.replaceTrack(video);
    } else {
      this.screenSender = this.pc.addTrack(video, stream);
      this.tryWireScreenSender();
      // Cap maxBitrate and mark the screen sender as low priority so audio
      // keeps its bandwidth share under contention.
      try {
        const params = this.screenSender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        const enc = params.encodings[0]! as RTCRtpEncodingParameters & { networkPriority?: string };
        enc.maxBitrate = SCREEN_BITRATE_MAX;
        enc.priority = "low";
        enc.networkPriority = "low";
        void this.screenSender.setParameters(params).catch(() => { /* race */ });
      } catch { /* harmless */ }
    }

    // System-audio sender — add, replace, or remove to match the stream.
    if (audio) {
      if (this.screenAudioSender) {
        void this.screenAudioSender.replaceTrack(audio);
      } else {
        this.screenAudioSender = this.pc.addTrack(audio, stream);
        this.tryWireScreenAudioSender();
      }
    } else if (this.screenAudioSender) {
      try { this.pc.removeTrack(this.screenAudioSender); } catch (err) { console.warn("removeTrack failed", err); }
      this.screenAudioSender = null;
      this.screenAudioSenderWired = false;
    }
  }

  // start kicks off the SDP exchange for the offerer side. The answerer
  // does nothing until handleSignal sees the offer.
  async start(): Promise<void> {
    if (!this.local.isOfferer) return;
    // Chat data channel must be created before the first offer so SCTP is
    // in the initial SDP. Creating the channel triggers negotiationneeded,
    // which generates the actual offer. Reliable + ordered: the room is
    // small and chat throughput is trivial, so reordering isn't tolerable.
    this.attachChatChannel(this.pc.createDataChannel("chat", { ordered: true }));
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
      await this.runOffer({ iceRestart: true });
    } catch (err) {
      console.warn("ICE restart failed", err);
    }
  }

  // runOffer creates+sends an offer with the perfect-negotiation makingOffer
  // guard. It's used both for the initial offer (triggered by data channel
  // creation in start()) and for renegotiations (screen-share toggle, ICE
  // restart). On the polite side, runOffer may race with an incoming offer
  // — handleSignal detects the collision and rolls this one back.
  private async runOffer(opts: { iceRestart?: boolean }): Promise<void> {
    if (this.isClosed()) return;
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer(opts);
      if (this.isClosed()) return;
      offer.sdp = munge(offer.sdp);
      await this.pc.setLocalDescription(offer);
      if (this.pc.localDescription) {
        this.cb.sendSignal({ kind: "sdp", description: this.pc.localDescription.toJSON() });
      }
    } catch (err) {
      console.warn("offer failed", err);
    } finally {
      this.makingOffer = false;
    }
  }

  private isClosed(): boolean {
    // RTCPeerConnection's signalingState includes "closed" at runtime, but
    // some TS DOM lib versions omit it from the union. Read through a cast
    // so the comparison stays type-safe on either lib.
    return (this.pc.signalingState as string) === "closed";
  }

  async handleSignal(data: SignalData): Promise<void> {
    if (data.kind === "sdp") {
      const desc = data.description;
      // Glare detection: an offer arriving while we have a local offer in
      // flight (or pending) collides. Polite side rolls back, impolite side
      // ignores. The original offerer (lexicographically smaller ID) is
      // impolite — flipping that would let the answerer's renegotiation
      // requests starve.
      const polite = !this.local.isOfferer;
      const offerCollision = desc.type === "offer"
        && (this.makingOffer || this.pc.signalingState !== "stable");
      this.ignoreOffer = !polite && offerCollision;
      if (this.ignoreOffer) return;
      try {
        await this.pc.setRemoteDescription(desc);
      } catch (err) {
        console.warn("setRemoteDescription failed", err);
        return;
      }
      await this.flushPendingIce();
      if (desc.type === "offer") {
        const answer = await this.pc.createAnswer();
        answer.sdp = munge(answer.sdp);
        await this.pc.setLocalDescription(answer);
        if (this.pc.localDescription) {
          this.cb.sendSignal({ kind: "sdp", description: this.pc.localDescription.toJSON() });
        }
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
        // Tolerate failures for candidates that belonged to an offer we
        // ignored due to glare; surface anything else as a warning.
        if (!this.ignoreOffer) console.warn("addIceCandidate failed", err);
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
