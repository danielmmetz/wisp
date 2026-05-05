// Screen-share capture wrapper. Two presets, picked at share time:
//
//   document — text/PDF/code: contentHint=text, max 5 fps. Encoder drops to
//              near-zero bandwidth on a still page; sharp at 1080p.
//   motion   — video/game: contentHint=motion, max 30 fps. Encoder accepts
//              more blur to keep the rate.
//
// 1080p is the cap on either preset; the browser may downscale on a smaller
// captured surface or under congestion. Frame rate is "at most" — the
// encoder runs slower on static content even in motion mode.

export type ShareMode = "document" | "motion";

export interface ShareCapture {
  // stream is the raw getDisplayMedia stream. The video track is what gets
  // sent to peers; audio (system audio when offered) is currently ignored —
  // see TODO at end.
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  // mode is the preset that was used; carried so the UI can tell the user
  // what it picked.
  mode: ShareMode;
}

// isDisplayMediaSupported is false on iOS Safari and any browser that hasn't
// shipped getDisplayMedia. UI should hide the share button when false.
export function isDisplayMediaSupported(): boolean {
  return typeof navigator !== "undefined"
    && typeof navigator.mediaDevices !== "undefined"
    && typeof navigator.mediaDevices.getDisplayMedia === "function";
}

// startShareCapture prompts the user with the browser's display-picker, then
// applies the preset. Throws if the user cancels (NotAllowedError) or the
// browser doesn't support getDisplayMedia. Caller is responsible for stopping
// every track on the returned stream when done.
export async function startShareCapture(mode: ShareMode): Promise<ShareCapture> {
  if (!isDisplayMediaSupported()) {
    throw new Error("screen sharing not supported in this browser");
  }
  const frameRate = mode === "document" ? 5 : 30;
  // We always ask for 1080p; the browser silently downscales to whatever the
  // chosen surface actually offers (a 1440p monitor returns 1440p, a 720p
  // window returns 720p, etc.).
  const constraints: MediaStreamConstraints & { video: MediaTrackConstraints } = {
    video: {
      frameRate: { max: frameRate },
      width: { max: 1920 },
      height: { max: 1080 },
    },
    // Request system audio where supported (Chrome/Edge for tab/window
    // sharing). The user can decline in the picker; we don't fail if the
    // browser ignores this.
    audio: true,
  };
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  const videoTrack = stream.getVideoTracks()[0];
  if (!videoTrack) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("display capture returned no video track");
  }
  // contentHint nudges the encoder: "text" → low fps, sharp; "motion" →
  // higher fps, accepts blur. Browsers without contentHint silently ignore.
  type WithHint = MediaStreamTrack & { contentHint?: string };
  (videoTrack as WithHint).contentHint = mode === "document" ? "text" : "motion";
  return { stream, videoTrack, mode };
}

// stopShareCapture stops every track on the given stream and clears any
// browser-managed indicators (the chrome bar). Safe to call multiple times.
export function stopShareCapture(cap: ShareCapture): void {
  for (const t of cap.stream.getTracks()) {
    try {
      t.stop();
    } catch (err) {
      console.warn("stop screen track failed", err);
    }
  }
}
