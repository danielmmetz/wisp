# wisp

Browser-based voice chat for small groups. Open the URL, share a code like `velvet-otter-42` with your friends, and you're talking. No accounts, no install, up to six peers per room. Rooms exist while people are in them and vanish when the last person leaves.

Audio is encrypted between peers. Every connection runs WebRTC's built-in DTLS-SRTP; on browsers that support [WebRTC Insertable Streams](https://developer.chrome.com/blog/webrtc-encoded-transform/) (Chrome, Firefox), an additional per-call group key is layered on top, derived client-side and never visible to the signaling server. iOS Safari currently runs on DTLS-SRTP only.

Text chat sits alongside the voice, riding per-peer WebRTC data channels — same trust model, same ephemerality. Joiners don't receive history; the channel is gone when the room is.

Voice activity is detected automatically, with adaptive thresholds that track each mic's noise floor so quiet and loud rooms both work. Each visit you're a fresh anonymous animal name, renamable in-room.

Noise suppression runs client-side via DeepFilterNet3 in WebAssembly, layered on top of the browser's built-in NS. Keyboard tapping, fans, and most non-stationary background noise stay out of the call. Always on, no toggle.

Voice bitrate adapts to observed loss (24–64 kbps) and RED forward-error-correction rides out short loss bursts. Signaling drops auto-reconnect with backoff; a failed peer connection gets one ICE restart before being declared gone. A per-peer good/degraded/poor indicator reflects loss and RTT.

Mic and speaker pickers, a mic-test meter, and per-peer volume sliders live behind a settings gear in the room header. Audio device choices persist across visits.
