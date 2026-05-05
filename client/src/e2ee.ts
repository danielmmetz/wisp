// Frame-level E2EE on top of DTLS-SRTP.
//
// Every peer in a room shares a 32-byte group key (derived in crypto.ts and
// distributed peer-to-peer via the signaling channel). Frames are encrypted
// with AES-GCM under (groupKey, IV). To keep IVs unique across senders, each
// peer prefixes its IVs with 8 bytes derived from its own peer ID:
//
//   IV (12B) = senderPrefix(8) || counter(4 BE)
//
// The 4-byte counter is sent in-band; the 8-byte senderPrefix is determined
// by which RTCPeerConnection the frame arrived on (one connection per peer
// pair in a mesh, so the receiver always knows the sender).
//
// Wire layout per frame:
//   [counter:4 BE | ciphertext-with-tag]
// DTX silence frames (zero-length) pass through unchanged.
//
// Browser support: Chromium ships RTCRtpSender.createEncodedStreams; Safari
// uses RTCRtpScriptTransform via a worker. v1 wires only the Chromium path.
// On other browsers DTLS-SRTP still encrypts everything between peers.

const COUNTER_BYTES = 4;
// Refuse to encrypt past this counter value to keep the (key, IV) space
// safely unique. AES-GCM IV reuse is catastrophic, so we abort the pipe well
// before wraparound rather than risk it. At 50 fps (20ms ptime) this is ~2.7
// years, far past any realistic call.
const COUNTER_LIMIT = 0xfffffff0;
// Receiver thresholds for surfacing "this peer's audio isn't decrypting" to
// the UI. We tolerate a brief burst at handshake (the sender's transform
// installs a moment after frames begin flowing); a sustained failure run is
// what we want to flag.
const SUSTAINED_FAILURES = 50;

interface RTCEncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
}

type EncodedStreams = {
  readable: ReadableStream<RTCEncodedFrame>;
  writable: WritableStream<RTCEncodedFrame>;
};

type WithStreams = {
  createEncodedStreams?: () => EncodedStreams;
};

export function isE2EEAvailable(): boolean {
  // ?nokey=1 in the URL disables the Insertable Streams transform entirely
  // so we fall back to DTLS-SRTP only. Useful for isolating audio-path
  // problems from E2EE problems without redeploying.
  if (typeof location !== "undefined" && new URL(location.href).searchParams.get("nokey") === "1") {
    return false;
  }
  return (
    typeof RTCRtpSender !== "undefined" &&
    "createEncodedStreams" in RTCRtpSender.prototype
  );
}

// CipherFailureSink is invoked when a receiver sees sustained decrypt
// failures. Wired by the room layer to surface a per-peer indicator.
export type CipherFailureSink = (peerId: string, healthy: boolean) => void;

// GroupCipher holds the imported AES-GCM key for a room. It's shared
// across all senders/receivers in the local mesh.
export class GroupCipher {
  static async forKey(rawKey: Uint8Array, onPeerHealth?: CipherFailureSink): Promise<GroupCipher> {
    if (rawKey.byteLength !== 32) {
      throw new Error(`group key must be 32 bytes, got ${rawKey.byteLength}`);
    }
    const aesKey = await crypto.subtle.importKey(
      "raw",
      rawKey as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    return new GroupCipher(aesKey, onPeerHealth);
  }

  private constructor(
    private aesKey: CryptoKey,
    private onPeerHealth?: CipherFailureSink,
  ) {}

  // wireSender plumbs encryption into a sender's encoded-frame stream
  // using the local peer's prefix. Pass localPeerId once at room-setup.
  // No-op on browsers without createEncodedStreams.
  wireSender(sender: RTCRtpSender, localPeerId: string): void {
    const s = sender as RTCRtpSender & WithStreams;
    if (!s.createEncodedStreams) return;
    const prefix = peerIdPrefix(localPeerId);
    let counter = 0;
    const { readable, writable } = s.createEncodedStreams();
    readable
      .pipeThrough(new TransformStream<RTCEncodedFrame, RTCEncodedFrame>({
        transform: async (frame, ctrl) => {
          if (counter >= COUNTER_LIMIT) {
            // We must not encrypt with a wrapped counter; that would reuse
            // an IV under the same key. Drop the frame and stop the pipe.
            ctrl.error(new Error("e2ee counter exhausted; key rotation required"));
            return;
          }
          frame.data = await this.encrypt(frame.data, prefix, counter++);
          ctrl.enqueue(frame);
        },
      }))
      .pipeTo(writable)
      .catch((err) => console.error("e2ee sender pipe ended", err));
  }

  // wireReceiver plumbs decryption into a receiver's encoded-frame stream
  // using the prefix of the remote peer it's bound to.
  wireReceiver(receiver: RTCRtpReceiver, remotePeerId: string): void {
    const r = receiver as RTCRtpReceiver & WithStreams;
    if (!r.createEncodedStreams) return;
    const prefix = peerIdPrefix(remotePeerId);
    let consecutiveFails = 0;
    let consecutiveOks = 0;
    let unhealthy = false;
    const { readable, writable } = r.createEncodedStreams();
    readable
      .pipeThrough(new TransformStream<RTCEncodedFrame, RTCEncodedFrame>({
        transform: async (frame, ctrl) => {
          try {
            frame.data = await this.decrypt(frame.data, prefix);
            consecutiveFails = 0;
            consecutiveOks++;
            // Recover from "unhealthy" after a clean run — gives the UI a
            // chance to clear the indicator if decryption resumes (e.g. key
            // rotation handoff completes).
            if (unhealthy && consecutiveOks > SUSTAINED_FAILURES) {
              unhealthy = false;
              this.onPeerHealth?.(remotePeerId, true);
            }
            ctrl.enqueue(frame);
          } catch (err) {
            // Drop frames we can't decrypt rather than tearing the pipe down.
            // A brief run is normal at the join handshake (the sender's
            // transform installs after the first few frames flow).
            consecutiveOks = 0;
            consecutiveFails++;
            if (!unhealthy && consecutiveFails >= SUSTAINED_FAILURES) {
              unhealthy = true;
              console.warn(`[e2ee] sustained decrypt failure (peer=${remotePeerId})`, err);
              this.onPeerHealth?.(remotePeerId, false);
            }
          }
        },
      }))
      .pipeTo(writable)
      .catch((err) => console.error("e2ee receiver pipe ended", err));
  }

  private async encrypt(payload: ArrayBuffer, prefix: Uint8Array, counter: number): Promise<ArrayBuffer> {
    if (payload.byteLength === 0) return payload; // DTX
    const iv = new Uint8Array(12);
    iv.set(prefix, 0);
    new DataView(iv.buffer).setUint32(8, counter, false);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.aesKey, payload);
    const out = new Uint8Array(COUNTER_BYTES + ct.byteLength);
    new DataView(out.buffer).setUint32(0, counter, false);
    out.set(new Uint8Array(ct), COUNTER_BYTES);
    return out.buffer;
  }

  private async decrypt(buf: ArrayBuffer, prefix: Uint8Array): Promise<ArrayBuffer> {
    if (buf.byteLength === 0) return buf;
    if (buf.byteLength <= COUNTER_BYTES) throw new Error("frame too small");
    const view = new DataView(buf);
    const counter = view.getUint32(0, false);
    const iv = new Uint8Array(12);
    iv.set(prefix, 0);
    new DataView(iv.buffer).setUint32(8, counter, false);
    const ct = new Uint8Array(buf, COUNTER_BYTES);
    return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.aesKey, ct);
  }
}

// peerIdPrefix derives a stable 8-byte IV prefix from a peer ID. The server
// emits 16-hex-char (= 8-byte) peer IDs; we decode those directly so two
// peers can independently compute each other's prefix from the wire.
function peerIdPrefix(peerId: string): Uint8Array {
  if (peerId.length !== 16 || !/^[0-9a-f]+$/.test(peerId)) {
    throw new Error(`unexpected peer ID format: ${peerId}`);
  }
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = parseInt(peerId.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
