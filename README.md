# wisp

Browser-based voice chat for small groups. Open the URL, share a code like `velvet-otter-42` with your friends, and you're talking. No accounts, no install, up to six peers per room. Rooms exist while people are in them and vanish when the last person leaves.

Audio is encrypted between peers. Every connection runs WebRTC's built-in DTLS-SRTP; on browsers that support [WebRTC Insertable Streams](https://developer.chrome.com/blog/webrtc-encoded-transform/) (Chrome, Firefox), an additional per-call group key is layered on top, derived client-side and never visible to the signaling server. iOS Safari currently runs on DTLS-SRTP only.

Voice only — no video or screen sharing. No push-to-talk; voice activity is detected automatically. Each visit you're a fresh anonymous animal name.

Noise suppression runs client-side via DeepFilterNet3 in WebAssembly, layered on top of the browser's built-in NS. Keyboard tapping, fans, and most non-stationary background noise stay out of the call. Always on, no toggle.
