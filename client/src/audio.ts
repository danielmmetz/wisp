// Microphone capture and the audio graph that feeds RTCPeerConnection.
//
// Path:
//   getUserMedia → MediaStreamSource → DeepFilterNet3 worklet (optional)
//                → MediaStreamDestination → outbound MediaStreamTrack
//
// The browser's AEC/NS/AGC handle the easy stuff. DeepFilterNet3 layers on top
// for non-stationary noise (typing, dogs, kids) where the browser's NS gives
// up. Assets (~17MB combined) are vendored under /dfn/v2/ and served by the
// Go binary; first call pays a one-time fetch then the browser caches them.
// If init fails for any reason, we fall back to passing the raw mic track —
// the call still works.
import { DeepFilterNet3Core } from "deepfilternet3-noise-filter";

const SAMPLE_RATE = 48000;
// Path-prefix for the vendored DFN3 assets (df_bg.wasm + DeepFilterNet3_onnx.tar.gz).
// The package's AssetLoader appends "/v2/pkg/df_bg.wasm" and
// "/v2/models/DeepFilterNet3_onnx.tar.gz".
const DFN_ASSET_BASE = "/dfn";
// Suppression strength, 0-100. 50 is the package default and a reasonable
// middle ground; raise for noisier environments.
const DFN_SUPPRESSION_LEVEL = 50;

export interface MicCapture {
  // outbound is the MediaStreamTrack to addTrack onto each RTCPeerConnection.
  outbound: MediaStreamTrack;
  // raw is the underlying mic track; useful for VAD energy calc.
  raw: MediaStreamTrack;
  // setMuted toggles the outbound track's enabled flag (transmit mute).
  setMuted: (muted: boolean) => void;
  // close releases the mic and tears down the audio graph.
  close: () => void;
}

export async function startMic(): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
    video: false,
  });
  const rawTrack = stream.getAudioTracks()[0];
  if (!rawTrack) throw new Error("no audio track from getUserMedia");

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  const dest = ctx.createMediaStreamDestination();

  let cleanup: (() => void) | null = null;

  // DFN3 noise suppression. If the WASM/model fetch or compile fails we
  // connect source → dest directly; the call still works on the browser's
  // built-in NS alone.
  try {
    const dfn = new DeepFilterNet3Core({
      sampleRate: SAMPLE_RATE,
      noiseReductionLevel: DFN_SUPPRESSION_LEVEL,
      assetConfig: { cdnUrl: DFN_ASSET_BASE },
    });
    await dfn.initialize();
    const node = await dfn.createAudioWorkletNode(ctx);
    source.connect(node).connect(dest);
    cleanup = () => {
      node.disconnect();
      source.disconnect();
      dfn.destroy();
    };
  } catch (err) {
    console.warn("DeepFilterNet3 unavailable; using raw mic", err);
    source.connect(dest);
    cleanup = () => source.disconnect();
  }

  const outboundTrack = dest.stream.getAudioTracks()[0];
  if (!outboundTrack) throw new Error("destination produced no output track");

  return {
    outbound: outboundTrack,
    raw: rawTrack,
    setMuted: (muted) => {
      outboundTrack.enabled = !muted;
    },
    close: () => {
      cleanup?.();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

// attachRemoteStream pipes a remote MediaStream through a WebAudio GainNode
// for playback so volume can exceed unity. Returns a setVolume callback
// taking a non-negative gain (1 = unity, >1 = boost).
export function attachRemoteStream(stream: MediaStream): {
  setVolume: (v: number) => void;
  close: () => void;
} {
  // Hidden, muted audio element keeps the WebRTC track "pulling" data in
  // Chromium; playback comes out of the WebAudio graph below.
  const el = document.createElement("audio");
  el.autoplay = true;
  el.muted = true;
  el.srcObject = stream;
  el.style.display = "none";
  document.body.appendChild(el);
  el.play().catch((err) => console.warn("remote audio play() failed", err));

  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  src.connect(gain).connect(ctx.destination);
  return {
    setVolume: (v) => {
      gain.gain.value = Math.max(0, v);
    },
    close: () => {
      el.srcObject = null;
      el.remove();
      void ctx.close();
    },
  };
}

// observeSpeaking samples the analyser's RMS at intervalMs and reports
// "speaking" / "not speaking" transitions via onChange. Lightweight VAD that
// drives the speaking indicator only — Opus DTX handles bandwidth.
export function observeSpeaking(
  track: MediaStreamTrack,
  onChange: (speaking: boolean) => void,
  opts: { thresholdDb?: number; intervalMs?: number } = {},
): () => void {
  const threshold = opts.thresholdDb ?? -45;
  const intervalMs = opts.intervalMs ?? 100;
  const ctx = new AudioContext();
  const stream = new MediaStream([track]);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let speaking = false;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const db = 20 * Math.log10(rms || 1e-9);
    const next = db > threshold;
    if (next !== speaking) {
      speaking = next;
      onChange(speaking);
    }
  }, intervalMs);
  return () => {
    clearInterval(timer);
    source.disconnect();
    void ctx.close();
  };
}
