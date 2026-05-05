// Microphone capture for RTCPeerConnection.
//
// The browser's AEC/NS/AGC handle the bulk of the work; the outbound track is
// the raw mic track. setMuted toggles the track's enabled flag (transmit mute).

const SAMPLE_RATE = 48000;

export interface MicCapture {
  // outbound is the MediaStreamTrack to addTrack onto each RTCPeerConnection.
  outbound: MediaStreamTrack;
  // raw is the underlying mic track; useful for VAD energy calc.
  raw: MediaStreamTrack;
  // setMuted toggles the outbound track's enabled flag (transmit mute).
  setMuted: (muted: boolean) => void;
  // close releases the mic.
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
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error("no audio track from getUserMedia");

  return {
    outbound: track,
    raw: track,
    setMuted: (muted) => {
      track.enabled = !muted;
    },
    close: () => {
      stream.getTracks().forEach((t) => t.stop());
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
