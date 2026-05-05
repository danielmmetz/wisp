// Microphone capture, noise suppression, remote-stream playback, VAD, and
// short notification tones. Everything that touches WebAudio lives here so
// there is exactly one shared AudioContext for the page.
//
// Outbound path:
//   getUserMedia → MediaStreamSource → DFN3 worklet → MediaStreamDestination
//                                                   → outbound MediaStreamTrack
//
// NS is on by default. ?nons=1 in the URL skips the worklet and sends the
// raw getUserMedia track instead — useful only for isolating an echo
// complaint from the noise suppression layer in a one-off debug session.
import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";

const SAMPLE_RATE = 48000;
const DFN_ASSET_BASE = "/dfn";
const DFN_SUPPRESSION_LEVEL = 50;

// Single AudioContext shared by every consumer in this module. Created on
// first use and resumed on visibility change so backgrounded tabs that throttle
// the context don't leave it suspended forever.
let sharedCtx: AudioContext | null = null;
function ctx(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && sharedCtx?.state === "suspended") {
        void sharedCtx.resume();
      }
    });
  }
  return sharedCtx;
}

// preloadNoiseSuppression begins fetching the DFN3 WASM and ONNX model so the
// first call to startMic doesn't pay the ~17MB download/compile cost while the
// user waits at "Connecting…". Subsequent startMic calls reuse the cached
// instance. Safe to call multiple times — the second is a no-op.
let dfnPromise: Promise<DeepFilterNet3Core | null> | null = null;
export function preloadNoiseSuppression(): Promise<DeepFilterNet3Core | null> {
  if (dfnPromise) return dfnPromise;
  dfnPromise = (async () => {
    try {
      const dfn = new DeepFilterNet3Core({
        sampleRate: SAMPLE_RATE,
        noiseReductionLevel: DFN_SUPPRESSION_LEVEL,
        assetConfig: { cdnUrl: DFN_ASSET_BASE },
      });
      await dfn.initialize();
      return dfn;
    } catch (err) {
      console.warn("DeepFilterNet3 preload failed; will use raw mic", err);
      return null;
    }
  })();
  return dfnPromise;
}

export interface MicOptions {
  // deviceId is the input device to capture. Empty string = system default.
  deviceId?: string;
}

export interface MicCapture {
  outbound: MediaStreamTrack;
  raw: MediaStreamTrack;
  setMuted: (muted: boolean) => void;
  close: () => void;
}

function noNS(): boolean {
  if (typeof location === "undefined") return false;
  return new URL(location.href).searchParams.get("nons") === "1";
}

export async function startMic(opts: MicOptions = {}): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      ...(opts.deviceId ? { deviceId: { exact: opts.deviceId } } : {}),
    },
    video: false,
  });
  const rawTrack = stream.getAudioTracks()[0];
  if (!rawTrack) throw new Error("no audio track from getUserMedia");

  let teardown: (() => void) | null = null;
  let outboundTrack: MediaStreamTrack = rawTrack;

  if (!noNS()) {
    const built = await buildNS(ctx(), stream);
    if (built) {
      outboundTrack = built.track;
      teardown = built.close;
    }
  }

  return {
    outbound: outboundTrack,
    raw: rawTrack,
    setMuted: (muted) => {
      outboundTrack.enabled = !muted;
      // Flip the raw track too so VAD on the raw path stops firing while the
      // user is muted (self-VAD is driven off raw).
      rawTrack.enabled = !muted;
    },
    close: () => {
      teardown?.();
      stream.getTracks().forEach((t) => t.stop());
    },
  };
}

// buildNS attaches the DFN3 worklet to the mic stream and returns the
// processed track plus a teardown. Falls back (returns null) if DFN3 isn't
// ready or fails to instantiate; caller should send the raw track instead.
async function buildNS(
  audioCtx: AudioContext,
  stream: MediaStream,
): Promise<{ track: MediaStreamTrack; close: () => void } | null> {
  try {
    const dfn = await preloadNoiseSuppression();
    if (!dfn) return null;
    const node = await dfn.createAudioWorkletNode(audioCtx);
    const source = audioCtx.createMediaStreamSource(stream);
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(node).connect(dest);
    const track = dest.stream.getAudioTracks()[0];
    if (!track) {
      source.disconnect();
      node.disconnect();
      return null;
    }
    return {
      track,
      close: () => {
        node.disconnect();
        source.disconnect();
      },
    };
  } catch (err) {
    console.warn("DFN3 setup failed; using raw mic", err);
    return null;
  }
}

// attachRemoteStream pipes a remote MediaStream through a WebAudio GainNode
// so volume can exceed unity (1.0 = system; up to ~2.0 for boost). Output
// device routing is global to the shared AudioContext via setOutputDevice;
// per-stream sinks aren't needed.
export function attachRemoteStream(stream: MediaStream): {
  setVolume: (v: number) => void;
  close: () => void;
} {
  const audioCtx = ctx();
  // Hidden, muted audio element keeps the WebRTC track "pulling" data on
  // Chromium. Without it, MediaStreamSource sometimes never emits frames.
  // It's muted so playback comes only from the WebAudio path.
  const el = document.createElement("audio");
  el.autoplay = true;
  el.muted = true;
  el.srcObject = stream;
  el.style.display = "none";
  document.body.appendChild(el);
  el.play().catch((err) => console.warn("remote audio play() failed", err));

  const src = audioCtx.createMediaStreamSource(stream);
  const gain = audioCtx.createGain();
  src.connect(gain).connect(audioCtx.destination);
  return {
    setVolume: (v) => {
      gain.gain.value = Math.max(0, v);
    },
    close: () => {
      gain.disconnect();
      src.disconnect();
      el.srcObject = null;
      el.remove();
    },
  };
}

// setOutputDevice routes everything that lands at AudioContext.destination
// (remote playback, tones) to the given device ID. Empty string falls back
// to the system default. Requires AudioContext.setSinkId (Chrome 110+);
// no-op on browsers that don't support it.
export async function setOutputDevice(deviceId: string): Promise<void> {
  const c = ctx() as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof c.setSinkId !== "function") return;
  try {
    await c.setSinkId(deviceId);
  } catch (err) {
    console.warn("setSinkId failed", err);
  }
}

// observeSpeaking samples RMS at intervalMs and emits "speaking" / "not
// speaking" transitions on onChange. Adaptive: tracks a slow-moving noise
// floor (EMA of RMS while not-speaking) and triggers when current RMS exceeds
// the floor by `marginDb`. Hysteresis (separate attack/release thresholds)
// prevents flapping at the boundary.
export function observeSpeaking(
  track: MediaStreamTrack,
  onChange: (speaking: boolean) => void,
  opts: { marginDb?: number; intervalMs?: number; floorDb?: number } = {},
): () => void {
  const margin = opts.marginDb ?? 12;
  const release = 6; // dB hysteresis
  const intervalMs = opts.intervalMs ?? 80;
  const audioCtx = ctx();
  const stream = new MediaStream([track]);
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let speaking = false;
  // Initial floor; will adapt downward as silence is observed.
  let floorDb = opts.floorDb ?? -55;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const db = 20 * Math.log10(rms || 1e-9);
    if (!speaking) {
      // Slow EMA toward current level when quiet; this lets the floor track
      // ambient changes (fan kicks on, AC turns off).
      floorDb = floorDb * 0.97 + db * 0.03;
    }
    const attack = floorDb + margin;
    const releaseDb = floorDb + (margin - release);
    const next = speaking ? db > releaseDb : db > attack;
    if (next !== speaking) {
      speaking = next;
      onChange(speaking);
    }
  }, intervalMs);
  return () => {
    clearInterval(timer);
    source.disconnect();
  };
}

// listAudioDevices returns the input/output device pairs for picker UI.
// Labels are populated only after the user has granted mic permission, so
// callers should call this after startMic the first time. Returns a stable
// snapshot; subscribe to navigator.mediaDevices.devicechange for updates.
export interface AudioDevice {
  deviceId: string;
  label: string;
}
export interface AudioDevices {
  inputs: AudioDevice[];
  outputs: AudioDevice[];
}
export async function listAudioDevices(): Promise<AudioDevices> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return { inputs: [], outputs: [] };
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  const inputs: AudioDevice[] = [];
  const outputs: AudioDevice[] = [];
  for (const d of all) {
    if (d.kind === "audioinput") inputs.push({ deviceId: d.deviceId, label: d.label || "Microphone" });
    else if (d.kind === "audiooutput") outputs.push({ deviceId: d.deviceId, label: d.label || "Speaker" });
  }
  return { inputs, outputs };
}

// Short, polite notification tones. Two-note ascending for join, descending
// for leave. Run on the shared context so they go to the user's selected
// output (when setSinkId is supported on AudioContext, Chrome 110+).
export function playJoinTone(): void {
  playTone([660, 880], 0.06);
}
export function playLeaveTone(): void {
  playTone([660, 440], 0.06);
}
function playTone(freqs: number[], gainPeak: number): void {
  const audioCtx = ctx();
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  const now = audioCtx.currentTime;
  const noteDur = 0.12;
  const gap = 0.02;
  const g = audioCtx.createGain();
  g.gain.value = 0;
  g.connect(audioCtx.destination);
  for (let i = 0; i < freqs.length; i++) {
    const o = audioCtx.createOscillator();
    o.type = "sine";
    o.frequency.value = freqs[i]!;
    o.connect(g);
    const start = now + i * (noteDur + gap);
    const peak = start + 0.02;
    const end = start + noteDur;
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(gainPeak, peak);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.start(start);
    o.stop(end + 0.02);
  }
}
