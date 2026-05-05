# wisp — Technical Spec

A self-hosted, browser-based, ephemeral voice chat for small groups. Conduit-style join UX, mesh WebRTC topology, end-to-end encrypted via standard SRTP. Designed for ad-hoc voice during gaming sessions.

## Goals

- **Easy to join.** Open URL, type a short code, you're in. No accounts, no install.
- **Discord-comparable voice quality.** Opus at conversational bitrate with browser-native AEC/NS/AGC plus client-side RNNoise.
- **Real E2EE.** Media never traverses a server that holds keys. SRTP between peers, plus a per-call ephemeral group key applied as a frame-level encryption layer. Signaling server only brokers SDP/ICE and encrypted key handoffs.
- **Self-hosted on small infra.** Single Go binary for signaling, deployed to Fly.io. Cloudflare TURN for NAT traversal.
- **Voice only, ephemeral rooms.** Rooms die when empty. No persistence, no history.

## Non-goals (v1)

- Screen sharing or video. Designed-for, not built (see Extensions).
- Native desktop or mobile clients. Designed-for, not built (see Extensions).
- Groups larger than ~5 concurrent participants. Mesh topology caps it.
- Persistent identity, friends lists, or always-on presence.
- Push-to-talk or global hotkeys. VAD only.
- Recording, transcripts, or any server-side audio processing.

## Architecture

Three components: signaling server, browser client, Cloudflare TURN.

```
                      ┌──────────────────┐
                      │  Signaling (Fly) │
                      │   - room codes   │
                      │   - SDP/ICE relay│
                      │   - TURN creds   │
                      └────────┬─────────┘
                               │ WebSocket (WSS)
                ┌──────────────┼──────────────┐
                │              │              │
           ┌────▼───┐     ┌────▼───┐     ┌────▼───┐
           │ Peer A │     │ Peer B │     │ Peer C │
           └────┬───┘     └────┬───┘     └────┬───┘
                │              │              │
                └──────────────┼──────────────┘
                       SRTP over UDP
                  (direct or via Cloudflare TURN)
```

Signaling sees room membership and SDP/ICE candidates. It does not see media. TURN sees encrypted SRTP packets it cannot decrypt; it does not hold keys.

## Signaling Server

**Language:** Go. Single static binary.
**Deployment:** Fly.io, single region (closest to majority of users; us-east for the default user).
**Storage:** in-memory only. No database.
**TLS:** Fly handles certificate provisioning and termination.

### Responsibilities

1. Generate and validate room codes.
2. Track ephemeral room membership (peer IDs, WebSocket connections).
3. Relay SDP offers/answers and ICE candidates between peers in a room.
4. Mint short-lived Cloudflare TURN credentials per peer on join.
5. Notify peers when others join or leave so the mesh can reconfigure.

### Room codes

Format: `adjective-noun`, e.g. `velvet-otter`. Two-word format is memorable and speakable over voice. The signaling server retries on collision and applies per-IP join rate limiting.

Generation rules:
- Wordlists curated to avoid offensive, ambiguous-spelling, or confusable words.
- Codes are case-insensitive.
- A code is allocated when the first peer creates a room and freed when the last peer leaves.
- Codes are not reused for at least 5 minutes after a room empties (avoids accidental rejoins to a fresh room).

### Wire protocol

WebSocket, JSON messages. Both directions use the same envelope:

```json
{ "type": "...", "payload": { ... } }
```

Client → server:

| type            | payload                              | meaning                          |
|-----------------|--------------------------------------|----------------------------------|
| `create_room`   | `{}`                                 | request a new room code          |
| `join_room`     | `{ "code": "velvet-otter" }`         | join an existing room            |
| `leave_room`    | `{}`                                 | clean disconnect (optional)      |
| `signal`        | `{ "to": "peerId", "data": {...} }`  | relay SDP or ICE to a peer       |

Server → client:

| type            | payload                                                  | meaning                         |
|-----------------|----------------------------------------------------------|---------------------------------|
| `room_created`  | `{ "code": "...", "peerId": "...", "turn": {...} }`      | room ready, here's your ID      |
| `room_joined`   | `{ "code": "...", "peerId": "...", "peers": [...], "turn": {...} }` | joined existing room |
| `peer_joined`   | `{ "peerId": "..." }`                                    | someone else joined             |
| `peer_left`     | `{ "peerId": "..." }`                                    | someone left                    |
| `signal`        | `{ "from": "peerId", "data": {...} }`                    | relayed signaling from a peer   |
| `error`         | `{ "code": "...", "message": "..." }`                    | room not found, full, etc.      |

`signal.data` is opaque to the server — it carries WebRTC SDP offers/answers and ICE candidates without inspection.

### TURN credentials

Server fetches ephemeral credentials from Cloudflare TURN API on join, with TTL of ~1 hour. Returned to client in `room_created` / `room_joined`. Client uses them to construct the `RTCIceServer` config. Credentials are per-peer to enable revocation.

### Limits

- Max peers per room: **6** (hard cap). Prevents accidental over-mesh.
- Max rooms in flight: configurable, default 1000.
- WebSocket idle timeout: 60s (with ping/pong keepalive every 25s).
- Messages rate-limited to 50/sec per connection (signaling bursts during ICE gathering can be brief but heavy).

### Security

- Rooms are auth'd by code possession. No accounts.
- Codes have ~10⁷ entropy; brute force is rate-limited per IP at 10 join attempts/minute. Sufficient given short room lifetimes.
- Signaling server logs only operational metrics (room count, peer count, error rates). No SDP, no IPs in logs beyond what Fly's edge already records.
- Server runs in a Fly app with no inbound ports beyond 443.

## Client

**Language:** TypeScript, no framework. Vanilla DOM, single HTML file with bundled JS via esbuild.
**Hosting:** Static, served from same Fly app under `/` (signaling lives at `/ws`). Or split to a CDN — doesn't matter.
**Browser support:** Evergreen Chromium, Firefox, Safari 16+. Mobile Safari acceptable but not optimized.

### Audio capture

```js
getUserMedia({
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    sampleRate: 48000,
  },
  video: false,
});
```

Browser AEC/NS/AGC handle most of the work. RNNoise is layered on top via an `AudioWorklet` for additional suppression of stationary noise (fans, AC, keyboard). RNNoise compiled to WASM, ~85KB, runs at <1% CPU on modern hardware.

Audio graph:

```
mic → MediaStreamSource → RNNoise AudioWorklet → MediaStreamDestination → RTCPeerConnection
```

Each remote peer's incoming stream attaches to its own `<audio>` element with an independent volume control.

### Codec / transport config

Opus parameters (set via SDP munging on the offer):

- Bitrate: 48 kbps mono (raise to 64 kbps if measured packet loss <2%).
- DTX (discontinuous transmission): enabled — saves bandwidth during silence.
- FEC (forward error correction): enabled — recovers from single-packet loss.
- Frame size: 20ms (default; balances latency and overhead).
- Application: `voip` (vs. `audio`) — biases Opus tuning for speech.

Browser handles SRTP, DTLS handshake, and ICE/STUN/TURN automatically given the `RTCConfiguration`.

### Per-call ephemeral group key

In addition to the per-link DTLS-SRTP encryption that WebRTC provides natively, each room derives a single ephemeral group key used for an additional frame-level encryption layer via [WebRTC Insertable Streams](https://developer.chrome.com/blog/webrtc-encoded-transform/). The group key:

- Is generated as 32 random bytes by the room creator at room creation.
- Is distributed to each new joiner over the signaling channel, encrypted to that joiner's ephemeral X25519 public key (peers exchange ephemeral DH public keys at WebSocket connect time).
- Lives only in client memory. Never persisted, never sent to the signaling server in plaintext.
- Is discarded when the local peer leaves the room.

Each audio frame is encrypted client-side with the group key (AES-GCM, frame counter as nonce) before being handed to the SRTP layer. The signaling server cannot read media even if the SRTP layer were somehow defeated, because the inner frame encryption uses a key the server never sees.

**Property gained:** per-call forward secrecy at the session granularity. Each room has independent key material, and past sessions cannot be decrypted from any future compromise of any peer or of the signaling server. DTLS-SRTP already provides forward secrecy via ECDHE on each pairwise handshake; this layer makes the property explicit, auditable, and structured to enable future ratcheting (see Extensions).

**What this does not provide:** in-call key rotation, post-compromise security, or protection against a peer who joined the room and later becomes untrusted (they had the key while present). See "Extension: Group key rotation" for stronger variants.

### VAD and connection topology

Silero VAD or a simple energy-threshold VAD runs client-side to drive the speaking indicator UI. It does not gate transmission — Opus DTX handles bandwidth during silence more efficiently than mute/unmute cycling, and full-duplex with DTX matches Discord's behavior.

Each client maintains an `RTCPeerConnection` to every other peer in the room. When `peer_joined` arrives, the existing peer with the lower peer ID initiates the offer (deterministic tie-breaker prevents glare). When `peer_left` arrives, the corresponding connection is torn down.

### UI

Minimal. One screen. Above-the-fold elements:

- Room code, large, with copy button.
- "Share" button (copies join URL).
- List of peers, one row each: name (anonymous animal name auto-assigned), speaking indicator (audio level meter), volume slider, mute toggle.
- Self row: same layout plus mic mute (transmit-side) toggle.
- Connection quality indicator per peer (good / degraded / poor based on `getStats()` packet loss and RTT).
- Leave button.

No chat, no settings menu, no avatars. Resist scope creep; the conduit-like simplicity is the product.

### Reconnection

If WebSocket drops, attempt reconnect with exponential backoff up to 30s. On reconnect, rejoin the same room code if still active. Existing peer connections survive WebSocket drops as long as their ICE remains valid; signaling is only needed for new peer arrivals.

If a peer connection itself drops (ICE failure), attempt one ICE restart before declaring the peer gone.

**Status:** deferred from v1. The current client treats a `failed`/`disconnected` `RTCPeerConnection` as terminal (the row's quality flips to "poor" and the room waits for an explicit `peer_left`). WS auto-reconnect with backoff and a single ICE-restart on peer-connection failure are the next reconnection-related items to land.

## Operational concerns

- **Bandwidth (signaling):** negligible. Few KB per peer per session lifetime.
- **Bandwidth (TURN, when relayed):** ~64 kbps per peer pair, both directions. Cloudflare free tier is 1TB/month — supports thousands of hours of voice.
- **TURN relay rate:** expect 20-40% of connections to require TURN (NAT type dependent). Direct P2P is preferred and attempted first.
- **Server cost:** Fly.io shared-cpu-1x with 256MB is sufficient for hundreds of concurrent rooms. ~$2/month.
- **Monitoring:** expose `/metrics` for Prometheus. Track room count, peer count, signaling message rate, error rate, WebSocket reconnect rate.

## Failure modes and behavior

| Failure                         | Behavior                                                 |
|---------------------------------|----------------------------------------------------------|
| Signaling server down           | Existing peer connections continue working; no new joins |
| Cloudflare TURN unavailable     | Direct P2P still works; symmetric-NAT users can't connect |
| Single peer has bad uplink      | Their audio degrades for everyone; others unaffected     |
| All peers behind symmetric NAT  | TURN relay; latency +20-40ms vs. direct                  |
| Browser tab backgrounded        | Audio continues; AudioWorklet survives                   |

## Extension: Screen sharing

Screen sharing on mesh works for ≤3 participants total. Beyond that, uplink saturation forces a topology change. The clean migration path is **swap mesh for an SFU** while keeping signaling and room UX intact.

### Path A: Mesh + screen share (small groups, ≤3)

Minimal additions to the existing mesh:

- New "Share screen" UI button. On click, `getDisplayMedia({ video: true, audio: true })`.
- Returned tracks are `addTrack`'d to every existing `RTCPeerConnection`. Browser handles renegotiation; signaling server already relays the resulting offers/answers without changes.
- Codec preference set to **VP9** then **AV1** (better for screen content's sharp edges and low motion than H.264).
- Bitrate cap at 2 Mbps for 1080p30; 4 Mbps for 1440p30. Configurable.
- UI shows a video element when any peer is sharing. Multiple simultaneous shares allowed but discouraged.

This works without any server-side change. The bandwidth math caps it:
- 3 peers, one sharing at 2 Mbps: sharer uploads 4 Mbps (2 streams × 2 Mbps), others download 2 Mbps. Tolerable.
- 4 peers, one sharing at 2 Mbps: sharer uploads 6 Mbps. Marginal on residential up.
- 5+ peers sharing: don't.

### Path B: SFU migration (any group size, recommended for ≥4)

Replace mesh with **LiveKit** as the media server. Keep signaling server and room-code UX as-is — it now provisions LiveKit room tokens instead of Cloudflare TURN credentials.

Architecture changes:

```
               ┌──────────────────┐
               │ Signaling (Fly)  │
               │  - room codes    │
               │  - LiveKit tokens│
               └────────┬─────────┘
                        │ WebSocket
            ┌───────────┼───────────┐
            │           │           │
       ┌────▼───┐  ┌────▼───┐  ┌────▼───┐
       │ Peer A │  │ Peer B │  │ Peer C │
       └────┬───┘  └────┬───┘  └────┬───┘
            └───────────┼───────────┘
                        │ SRTP
                  ┌─────▼─────┐
                  │  LiveKit  │
                  │   (SFU)   │
                  └───────────┘
```

What changes:

- **Client:** swap raw `RTCPeerConnection` for `livekit-client` SDK. Same audio capture, same RNNoise, same UI.
- **Signaling server:** issues LiveKit JWT room tokens on join instead of TURN credentials. Cloudflare TURN no longer needed (LiveKit can use its own TURN or its public IP).
- **New component:** LiveKit server. Single Go binary, but needs **public IP with UDP port range exposed** (typically 50000-60000). Fly.io supports UDP ingress. Could also run on a Hetzner VPS for ~$5/month if Fly's UDP pricing becomes unfavorable.
- **E2EE:** enable LiveKit's [E2EE module](https://docs.livekit.io/home/client/tracks/encryption/) using a shared passphrase derived from the room code, or a separate key shared via the signaling channel. SFU sees encrypted frames, cannot decrypt. Real E2EE preserved, with caveats around late-joiner key distribution that LiveKit's library handles.
- **Simulcast:** enabled for screen share so viewers on weak connections get a downscaled layer.

What stays the same:

- Room codes and join URL flow.
- VAD-driven UI, speaking indicators, per-peer volume sliders.
- Ephemeral rooms, no accounts.
- Browser-only client.

Capacity after migration: comfortably 20-30 peers per room with voice + one screen share. Hundreds with voice only. Well past anything the use case will hit.

### Migration trigger

Stay on mesh until one of these is true:
- Regular use of >5 concurrent peers.
- Screen sharing becomes a frequent ask.
- Any user reports CPU pegging during calls (mesh encode load).

When the trigger hits, migrate. The signaling server, room UX, and client UI all survive; only the media plumbing changes.

## Extension: Desktop client

A native desktop client interoperates with browser clients trivially because WebRTC is a wire protocol, not a browser feature. Same SRTP, same SDP, same signaling server, same rooms. A native peer and a browser peer in the same room don't know or care about each other's runtime.

### Implementation options

| Stack                 | Pros                                                         | Cons                                              |
|-----------------------|--------------------------------------------------------------|---------------------------------------------------|
| Tauri + webrtc-rs     | Small binary, native feel, Rust ecosystem                    | webrtc-rs is less mature than libwebrtc           |
| Electron + libwebrtc  | Reuses entire browser client codebase, fastest to ship       | 100MB+ binary, RAM-heavy                          |
| Pion (Go) + native UI | Single language with the server, mature WebRTC stack         | Native UI in Go is rough; consider Wails or Fyne  |

**Recommendation:** Tauri + webrtc-rs if/when this happens. Matches the minimalism of the rest of the stack. Electron is the safe shortcut if shipping speed matters more than binary size.

### What native enables

- **Global hotkeys.** PTT (if ever added) or push-to-mute that work when unfocused.
- **System tray + autostart.** Always-on presence in a default room.
- **Lower audio I/O latency.** ~5-10ms vs. browser's ~20-40ms. Real but small gain.
- **Native noise suppression.** Run RNNoise as a native lib, free up the WASM tax. Or integrate a commercial SDK.
- **OS-level mic indicators and Do Not Disturb integration.**
- **No tab-killing the call.** The most underrated benefit.

### What stays the same

- Signaling protocol (the JSON envelope above is portable).
- Room codes, join flow.
- Cloudflare TURN credentials (or LiveKit tokens if migrated).
- Audio codec, bitrate, FEC/DTX config.
- Interop with browser clients.

### Scope of the build

Desktop client should be considered only after the browser client has stabilized and there's a concrete pain point it solves (probably "tab-killing the call" or "want always-on presence"). Maintaining two clients doubles surface area for connection state, reconnection logic, and UI parity. Don't take it on without justification.

## Extension: Auth-gated deployment (TinyAuth + PocketID)

For deployments where participants are known users in an existing identity stack, the signaling server can sit behind a TinyAuth + PocketID reverse proxy (typical homelab pattern with Caddy in front). This trades the conduit-style "anyone with the code joins" UX for verified identity, scoped access control, and audit logging.

### What changes

- **Caddy + TinyAuth gate the WebSocket upgrade.** TinyAuth injects `Remote-User` / `Remote-Email` / `Remote-Name` headers; the signaling server trusts them because nothing reaches the server except via the proxy.
- **Signaling server reads identity from headers** on WebSocket upgrade. Replaces auto-assigned animal names with real display names. Adds `email` and `displayName` to peer metadata in `peer_joined` events.
- **Room creation optionally scoped** to a PocketID group, so e.g. only members of a `gaming` group can create or join rooms.
- **Room codes become handles, not auth.** Codes can shorten (3 chars is fine when brute force gates on auth) or be replaced with named rooms (`#late-night`).
- **No login UI in the SPA.** By the time the page loads, the user is authed.

### What stays the same

- Mesh topology, SRTP, Cloudflare TURN, Opus config, RNNoise — all unchanged.
- Wire protocol stays compatible; identity fields are additive.
- Ephemeral rooms, voice-only, VAD-driven UI.

### Tradeoff

Auth-gating breaks ad-hoc joins for people outside the IdP. Mitigations:

- Add external participants as PocketID guest accounts (control-heavy, friction-heavy).
- Keep an unauthenticated guest-code path alongside the authed path (defeats most of the auth gain).
- Configure PocketID to accept social login or external OIDC issuers (cleanest, recommended if pursuing this).

### When to enable

If participants are predominantly already in PocketID (homelab users, work team, family with accounts), enable it — the identity, access control, and auditability wins are real and the protocol changes are small. If the use case is ad-hoc gaming with rotating outside friends, keep the v1 spec's anonymous join flow and don't fight the auth wall.

## Extension: Group key rotation

The v1 group key is per-call: fresh at room creation, discarded at room end. Two stronger variants tighten the forward-secrecy and post-compromise-security properties at increasing engineering cost.

### Variant A: Rotate on membership change

Generate a new group key whenever a peer joins or leaves. Past audio is unrecoverable from any key obtained after that membership change — including by the peer who departed.

**Property gained:** a peer who was in the room at time T can decrypt only audio from epochs they were a member of. If they leave at T+5min, audio after T+5min is unrecoverable to them even if they recorded the ciphertext.

**What this requires:**

- An "epoch" field in each encrypted frame's header so receivers know which key to apply.
- A small key cache (last 1-2 epochs, ~200ms lookback) so in-flight frames straddling a rotation still decrypt.
- A deterministic leader (lowest peer ID) responsible for generating the next key on membership change and distributing it via the existing per-peer DH-encrypted channel.
- Atomic switchover: leader announces "epoch N+1 begins at frame F"; all peers prepare the new key; everyone switches at frame F.
- Race handling for back-to-back membership changes (debounce or queue).

**Realistic threat addressed:** a participant later becomes untrusted (left the friend group, lost their device, compromised account) and you don't want them retroactively decrypting later sessions even with recorded ciphertext. Reasonable scenario for a long-running shared room.

**Estimated cost:** ~300-500 lines of client code plus signaling protocol additions for epoch announcements. Bugs cluster around race conditions when memberships change quickly; failure mode is brief audio dropouts for affected peers, not security failures.

### Variant B: Continuous in-call ratcheting

Rotate the group key on a fixed cadence (every N seconds or M frames) regardless of membership. Each new key is derived via HKDF over the previous key plus epoch number, so the chain is one-way.

**Property gained:** an attacker who passively records all encrypted traffic and later compromises a peer mid-call gets only the keys for the current epoch onward, not the entire call's history. Combined with Variant A, gives the full Signal-style forward-secrecy posture.

**What this requires (in addition to Variant A):**

- Coordinated rotation across all peers without a central coordinator. Time-based drifts; frame-counter-based requires shared frame counters per stream. Practical approach: leader broadcasts epoch transitions on a timer.
- Wider lookback window for peers who briefly disconnect or miss a rotation message.
- Disciplined key zeroization in JS: explicitly overwrite key buffers, avoid pinning in closures, accept that browsers don't make secure deletion easy.
- At this complexity level, importing [openmls](https://github.com/openmls/openmls) (compiled to WASM) becomes attractive because MLS solves all of the above formally as a standardized group key agreement protocol.

**Realistic threat addressed:** harvest-now-decrypt-later attacks where ciphertext is captured continuously and a peer is compromised at some future point. Low probability for the gaming-voice use case; standard threat model for journalist/dissident communications.

**Estimated cost:** if hand-rolled, several hundred more lines on top of Variant A and a long debugging tail around state-machine edge cases. If adopting MLS via openmls, the integration work is large (KeyPackage exchange via signaling, group state persistence, handling rejoin) but the cryptographic core is provided by the library.

### When to add each

- **Variant A** is worth building if the use case shifts toward longer-lived rooms with rotating membership, or if any participant ever needs to be cleanly evicted with retroactive forward secrecy. Self-contained, bounded complexity, defensible property.
- **Variant B** is worth building only if the project itself becomes about the cryptography rather than the voice chat. The marginal security gain over Variant A for this threat model is small; the engineering tail is long.

## Summary of build order

1. Signaling server (Go, ~300 LOC + wordlists).
2. Browser client (TypeScript, vanilla DOM, ~600 LOC + RNNoise WASM).
3. Cloudflare TURN integration.
4. Per-call ephemeral group key with frame-level encryption via Insertable Streams (~150 LOC client-side + ephemeral DH exchange in signaling protocol).
5. Deploy to Fly.io.
6. Test with real gaming sessions.
7. Iterate based on actual quality and join-flow friction.

Extensions (screen share, desktop, SFU migration, auth-gating, group key rotation) are deferred until the v1 stack hits a real limit or a concrete need.
