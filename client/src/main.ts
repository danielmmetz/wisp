// Entrypoint. Wires lobby form → Room.create()/join(), and Room callbacks →
// the DOM helpers in ui.ts. No framework, no router; the URL ?room= param
// just pre-fills the join field and auto-submits.

import {
  attachRemoteStream,
  listAudioDevices,
  preloadNoiseSuppression,
  setOutputDevice,
  startMic,
  type AudioDevice,
} from "./audio.ts";
import { bindDiagnostics, type DiagnosticsController } from "./diagnostics.ts";
import { Room } from "./room.ts";
import { isDisplayMediaSupported } from "./screen.ts";
import {
  $,
  appendChatMessage,
  appendChatSystem,
  appendPeerRow,
  bindChatComposer,
  bindChatMessageActions,
  bindScreenShareButton,
  bindSelfBlock,
  clearChat,
  createMicLevelMeter,
  createPresenterView,
  deleteChatMessage,
  editChatMessage,
  fillDeviceSelect,
  makePeerRow,
  releaseAuthorColor,
  renameChatAuthor,
  setLobbyError,
  setPeerCount,
  setRoomStatus,
  shareLink,
  showLobby,
  showRoom,
} from "./ui.ts";
import type { MicCapture } from "./audio.ts";
import type { PeerStats } from "./peer.ts";
import type {
  PeerRowHandle,
  MicLevelMeter,
  PresenterView,
  ScreenShareButton,
  SelfBlockHandle,
} from "./ui.ts";

let room: Room | null = null;
let mic: MicCapture | null = null;
const rows = new Map<string, PeerRowHandle>();
// Latest known peer connection state, keyed by peer id. Drives the
// diagnostics-trigger health tint when 2+ peers all collapse at once.
// Cleared on leave/reset. Updated from onConnectionState/onPeerRemoved.
const peerConnectionStates = new Map<string, RTCPeerConnectionState>();
// signalingHealth flips to "reconnecting" while we're redialing the WS;
// recomputeHealth treats that as bad regardless of peer state. Reset by
// onReconnected/onJoined and on leave.
let signalingHealth: "ok" | "reconnecting" = "ok";
let selfBlock: SelfBlockHandle | null = null;
let qualityTimer: number | null = null;
let localId: string | null = null;
let presenterView: PresenterView | null = null;
let screenShareBtn: ScreenShareButton | null = null;
let diagnostics: DiagnosticsController | null = null;
// Remote screen-audio playback. Routed through attachRemoteStream so it
// goes through the shared AudioContext (which honors the user's selected
// output device via setSinkId). Self-presenters skip this to avoid echo.
// setVolume(0) gives an independent mute from the presenter's voice.
let remoteScreenAudio: { close: () => void; setVolume: (v: number) => void } | null = null;

// User audio preferences. Persisted in localStorage so a returning user
// doesn't need to reselect their headset on every visit.
const STORAGE_KEY = "wisp.audioPrefs";
interface AudioPrefs {
  inputDeviceId: string;
  outputDeviceId: string;
}
function loadPrefs(): AudioPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AudioPrefs>;
      return {
        inputDeviceId: parsed.inputDeviceId ?? "",
        outputDeviceId: parsed.outputDeviceId ?? "",
      };
    }
  } catch {
    /* fall through to defaults */
  }
  return { inputDeviceId: "", outputDeviceId: "" };
}
function savePrefs(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* no-op; private mode etc. */
  }
}
const prefs = loadPrefs();

// Last display name the user explicitly chose. Prefilled into the lobby
// name field on load, and into the in-room rename input. Updated when the
// user submits the lobby with a non-empty name or renames in-room — never
// from server-assigned animal-name fallbacks.
const NAME_STORAGE_KEY = "wisp.displayName";
function loadStoredName(): string {
  try {
    return localStorage.getItem(NAME_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveStoredName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(NAME_STORAGE_KEY, trimmed);
  } catch {
    /* no-op; private mode etc. */
  }
}

let levelMeter: MicLevelMeter | null = null;

async function ensureMic(): Promise<MicCapture> {
  if (!mic) {
    try {
      mic = await startMic({ deviceId: prefs.inputDeviceId });
    } catch (err) {
      // Browsers rotate the opaque deviceId hash across sessions/permission
      // grants, so a saved preference can become unmatchable and getUserMedia
      // throws OverconstrainedError. Drop the stale ID and retry with the
      // system default rather than dead-ending the join.
      if (
        prefs.inputDeviceId &&
        err instanceof Error &&
        err.name === "OverconstrainedError"
      ) {
        prefs.inputDeviceId = "";
        savePrefs();
        mic = await startMic({});
      } else {
        throw err;
      }
    }
    if (prefs.outputDeviceId) void setOutputDevice(prefs.outputDeviceId);
    // After permission is granted, device labels become readable; refresh the
    // pickers so the user sees friendly names if they open settings later.
    void refreshDevicePickers();
  }
  return mic;
}

function releaseMic(): void {
  mic?.close();
  mic = null;
  levelMeter?.stop();
}

async function refreshDevicePickers(): Promise<void> {
  let devices: { inputs: AudioDevice[]; outputs: AudioDevice[] };
  try {
    devices = await listAudioDevices();
  } catch (err) {
    console.warn("enumerateDevices failed", err);
    return;
  }
  const inSel = document.querySelector<HTMLSelectElement>("#mic-select");
  const outSel = document.querySelector<HTMLSelectElement>("#speaker-select");
  if (inSel) fillDeviceSelect(inSel, devices.inputs, prefs.inputDeviceId);
  if (outSel) fillDeviceSelect(outSel, devices.outputs, prefs.outputDeviceId);
}

// Peer count surfaced on the rail-meta line. We include self in the total
// even though self isn't in the .rail-list — it matches what a user counts
// as "people in this room".
function refreshPeerCount(): void {
  setPeerCount(rows.size + (localId ? 1 : 0));
}

function buildRoomCallbacks(): ConstructorParameters<typeof Room>[1] {
  return {
    onJoined: ({ code, localId: id, name }) => {
      localId = id;
      showRoom(code);
      setRoomStatus("Connecting…");
      signalingHealth = "ok";
      recomputeHealth();
      diagnostics?.setStuckHint(true);
      selfBlock = bindSelfBlock({
        name,
        onMuteToggle: (m) => mic?.setMuted(m),
        onRenameRequest: (next) => {
          saveStoredName(next);
          room?.rename(next);
        },
        onLeaveRequest: () => leaveRoom(),
      });
      // The mic was pre-muted in startCreate/startJoin; sync the UI.
      selfBlock.setMuted(true);
      selfBlock.setQuality("unknown");
      refreshPeerCount();
      startQualityPolling();
      // Reveal the share button only when the browser actually supports
      // getDisplayMedia (desktop, mostly) and we're inside a room.
      if (isDisplayMediaSupported()) screenShareBtn?.setVisible(true);
    },
    onPeerAdded: (id, name) => {
      if (rows.has(id)) return;
      const row = makePeerRow({
        id,
        name,
        onMuteToggle: (m) => {
          const stream = remoteStreams.get(id);
          if (stream) {
            for (const t of stream.getAudioTracks()) t.enabled = !m;
          }
        },
        onKickRequest: () => room?.kick(id),
      });
      row.setQuality("unknown");
      rows.set(id, row);
      appendPeerRow(row);
      refreshPeerCount();
      // Suppress the system line during initial-room population: localId is
      // still null until onJoined fires, which happens after the existing
      // peers are walked. Genuine peer_joined arrivals fire afterwards with
      // localId set, so they do produce "X joined".
      if (localId) appendChatSystem(`${name} joined`);
    },
    onPeerRemoved: (id, name, reason) => {
      rows.get(id)?.destroy();
      rows.delete(id);
      remoteStreams.delete(id);
      peerConnectionStates.delete(id);
      releaseAuthorColor(id);
      refreshPeerCount();
      if (name) {
        if (reason.kind === "kicked") {
          const by = reason.byName || "someone";
          appendChatSystem(`${by} removed ${name}`);
        } else {
          appendChatSystem(`${name} left`);
        }
      }
      recomputeHealth();
    },
    onPeerRenamed: (id, name) => {
      if (id === localId) {
        selfBlock?.setName(name);
      } else {
        rows.get(id)?.setName(name);
      }
      renameChatAuthor(id, name);
    },
    onRemoteStream: (id, stream) => {
      remoteStreams.set(id, stream);
      rows.get(id)?.attach(stream);
    },
    onSpeakingChange: (id, speaking) => {
      if (id === localId) {
        selfBlock?.setSpeaking(speaking);
        return;
      }
      rows.get(id)?.setSpeaking(speaking);
    },
    onConnectionState: (id, state) => {
      peerConnectionStates.set(id, state);
      const row = rows.get(id);
      if (!row) {
        recomputeHealth();
        return;
      }
      switch (state) {
        case "connected":
          setRoomStatus("");
          diagnostics?.setStuckHint(false);
          break;
        case "disconnected":
        case "failed":
          row.setQuality("poor");
          break;
      }
      recomputeHealth();
    },
    onCipherHealth: (id, healthy) => {
      rows.get(id)?.setCipherHealth(healthy);
    },
    onChatMessage: (msg) => {
      appendChatMessage({
        id: msg.id,
        from: msg.from,
        isSelf: msg.isSelf,
        name: msg.name,
        body: msg.body,
        ts: msg.ts,
      });
    },
    onChatEdited: (info) => {
      editChatMessage(info.id, info.body, info.editedTs);
    },
    onChatDeleted: (info) => {
      deleteChatMessage(info.id);
    },
    onPresenterChanged: (peerId, stream) => {
      // The pane never auto-opens; the rail indicator is the entry point.
      // Here we just record who's presenting (which drives the indicator
      // and refreshes any open pane content), and route remote audio
      // through the shared AudioContext.
      if (!peerId) {
        presenterView?.setActive(null);
        remoteScreenAudio?.close();
        remoteScreenAudio = null;
        screenShareBtn?.setSharing(false);
        return;
      }
      const isSelf = peerId === localId;
      // Sharing state on the header button is purely "are *we* sharing".
      // Remote presenters don't gate the button — clicking starts a
      // takeover that replaces them.
      screenShareBtn?.setSharing(isSelf);
      const name = isSelf
        ? "you"
        : (rows.get(peerId)?.el.querySelector<HTMLElement>(".nm")?.textContent ?? "screen share");
      presenterView?.setActive({ name, stream, isSelf });
      // Audio routing: only attach when we have an actual stream and the
      // presenter is remote. Self skips to avoid echo. Re-attach when a
      // takeover swaps presenters mid-stream and reset the mute toggle —
      // the PresenterView resets its own visual state on presenter change
      // for the same reason.
      remoteScreenAudio?.close();
      remoteScreenAudio = stream && !isSelf ? attachRemoteStream(stream) : null;
    },
    onReconnecting: (attempt) => {
      setRoomStatus(`Reconnecting (attempt ${attempt})…`);
      diagnostics?.setStuckHint(true);
      signalingHealth = "reconnecting";
      recomputeHealth();
      // Visually mark all peer rows as poor while the room is in limbo.
      for (const r of rows.values()) r.setQuality("poor");
    },
    onReconnected: ({ localId: id }) => {
      // Server hands out a fresh peer ID on every join — refresh ours so
      // isSelf checks (e.g. presenter recognition) keep working.
      localId = id;
      setRoomStatus("");
      signalingHealth = "ok";
      recomputeHealth();
      // Stuck hint stays true until at least one peer reaches connected;
      // onConnectionState clears it.
    },
    onLeft: (reason) => {
      stopQualityPolling();
      for (const r of rows.values()) r.destroy();
      rows.clear();
      peerConnectionStates.clear();
      signalingHealth = "ok";
      remoteStreams.clear();
      clearChat();
      selfBlock?.reset();
      selfBlock = null;
      localId = null;
      setPeerCount(0);
      setRoomStatus("");
      diagnostics?.reset();
      presenterView?.setActive(null);
      presenterView?.setOpen(false);
      remoteScreenAudio?.close();
      remoteScreenAudio = null;
      screenShareBtn?.setSharing(false);
      screenShareBtn?.setVisible(false);
      releaseMic();
      showLobby();
      if (reason === "user left") {
        setLobbyError(null);
      } else if (reason.startsWith("kicked by ")) {
        const by = reason.slice("kicked by ".length);
        setLobbyError(`Removed from the room by ${by}.`);
      } else if (reason === "kicked from the room") {
        setLobbyError("Removed from the room.");
      } else {
        setLobbyError(`Disconnected: ${reason}`);
      }
      room = null;
    },
    onError: (msg) => {
      setLobbyError(msg);
      stopQualityPolling();
      releaseMic();
      diagnostics?.reset();
      room = null;
    },
  };
}

const remoteStreams = new Map<string, MediaStream>();

function startQualityPolling(): void {
  stopQualityPolling();
  qualityTimer = window.setInterval(async () => {
    if (!room) return;
    let stats: Map<string, PeerStats>;
    try {
      stats = await room.peerStats();
    } catch (err) {
      console.warn("peerStats failed", err);
      return;
    }
    for (const [id, s] of stats) {
      const row = rows.get(id);
      if (!row) continue;
      row.setTransport(s.transport ?? "unknown");
      row.setQuality(qualityFromStats(s));
    }
    selfBlock?.setQuality(selfQualityFromStats(stats));
    room.applyAdaptiveBitrate(stats);
    recomputeHealth(stats);
  }, 2000);
}
function stopQualityPolling(): void {
  if (qualityTimer !== null) {
    window.clearInterval(qualityTimer);
    qualityTimer = null;
  }
}

// qualityFromStats maps inbound loss + RTT into the three-bucket UI. We
// favor loss over RTT because perceived call quality drops fast with loss
// (jitter buffer can paper over RTT, not over missing frames).
function qualityFromStats(s: PeerStats): "good" | "degraded" | "poor" | "unknown" {
  return bucket(s.lossRate, s.rttMs);
}

// selfQualityFromStats reflects how well our outbound audio is reaching the
// room. Each peer's RR tells us how much of our send stream they lost; we
// take the worst report — if even one listener is hearing us badly, that's
// our upload problem. RR data lags by a few seconds, so until any peer has
// reported back we stay "unknown".
function selfQualityFromStats(stats: Map<string, PeerStats>): "good" | "degraded" | "poor" | "unknown" {
  let worstLoss: number | undefined;
  let worstRtt: number | undefined;
  for (const s of stats.values()) {
    const l = s.outboundLossRate;
    if (typeof l === "number" && Number.isFinite(l)) {
      if (worstLoss === undefined || l > worstLoss) worstLoss = l;
    }
    const r = s.outboundRttMs;
    if (typeof r === "number" && Number.isFinite(r)) {
      if (worstRtt === undefined || r > worstRtt) worstRtt = r;
    }
  }
  return bucket(worstLoss, worstRtt);
}

function bucket(loss: number | undefined, rtt: number | undefined): "good" | "degraded" | "poor" | "unknown" {
  if (typeof loss !== "number" || !Number.isFinite(loss)) return "unknown";
  if (loss >= 0.05 || (rtt !== undefined && rtt > 400)) return "poor";
  if (loss >= 0.02 || (rtt !== undefined && rtt > 200)) return "degraded";
  return "good";
}

// recomputeHealth feeds the diagnostics-trigger tint. Rules are tuned to
// "is this actionable for the local user?" rather than "is anyone in the
// room having a bad time?" — the per-peer rail rows already surface
// peer-specific issues; the global icon should not cry wolf about
// problems on the *other* end of the call.
//
//   bad  — WS reconnecting (server connection lost), or 2+ peers all
//          failed/disconnected at once (likely our network)
//   warn — listeners are losing our audio (selfQuality degraded/poor),
//          which means our upload is hurting
//   good — otherwise (single-peer issues, relayed transport, inbound
//          loss from one peer all stay quiet here)
function recomputeHealth(stats?: Map<string, PeerStats>): void {
  if (!diagnostics) return;
  if (signalingHealth === "reconnecting") {
    diagnostics.setHealth("bad");
    return;
  }
  if (peerConnectionStates.size >= 2) {
    let allBroken = true;
    for (const state of peerConnectionStates.values()) {
      if (state !== "failed" && state !== "disconnected") {
        allBroken = false;
        break;
      }
    }
    if (allBroken) {
      diagnostics.setHealth("bad");
      return;
    }
  }
  if (stats && stats.size > 0) {
    const sq = selfQualityFromStats(stats);
    if (sq === "poor" || sq === "degraded") {
      diagnostics.setHealth("warn");
      return;
    }
  }
  diagnostics.setHealth("good");
}

function readNameFromLobby(): string {
  const raw = (($("#name-input") as HTMLInputElement).value ?? "").trim();
  if (raw) saveStoredName(raw);
  return raw;
}

// Some DOMException-derived errors (notably Chrome's OverconstrainedError)
// have an empty .message, which would render as a blank lobby banner that
// looks like the click did nothing. Fall back to the error name so the
// user always sees something actionable.
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || String(err);
  return String(err);
}

async function startCreate(): Promise<void> {
  setLobbyError(null);
  try {
    const m = await ensureMic();
    // Disable the track before the Room hands it to the peer connection so
    // the outbound sender ships silence from packet zero — the user is muted
    // from the very first byte, not just after onJoined fires.
    m.setMuted(true);
    room = new Room(m, buildRoomCallbacks());
    await room.create(readNameFromLobby());
  } catch (err) {
    setLobbyError(formatError(err));
  }
}

async function startJoin(code: string): Promise<void> {
  setLobbyError(null);
  if (!code) {
    setLobbyError("Enter a room code");
    return;
  }
  try {
    const m = await ensureMic();
    // See startCreate: pre-mute so the peer connection ships silence from
    // the start.
    m.setMuted(true);
    room = new Room(m, buildRoomCallbacks());
    await room.join(code, readNameFromLobby());
  } catch (err) {
    setLobbyError(formatError(err));
  }
}

async function copyLink(): Promise<void> {
  const code = ($("#room-code") as HTMLElement).textContent ?? "";
  if (!code) return;
  try {
    await navigator.clipboard.writeText(shareLink(code));
    setRoomStatus("Link copied");
    setTimeout(() => setRoomStatus(""), 1500);
  } catch {
    setRoomStatus("Couldn't copy link");
  }
}

// initShareSupport flips a body class once at startup based on whether the
// browser exposes navigator.share. CSS uses the class to swap each share-
// or-copy button's icon between a share arrow and a clipboard glyph; we
// also retitle the buttons here so the tooltip matches the action.
function initShareSupport(): void {
  type Nav = Navigator & { share?: unknown };
  if (typeof (navigator as Nav).share !== "function") return;
  document.body.classList.add("share-supported");
  for (const b of document.querySelectorAll<HTMLButtonElement>(".share-or-copy")) {
    b.title = "Share room link";
    b.setAttribute("aria-label", "Share room link");
  }
}

// shareRoom uses the Web Share API where available (mobile, mostly), so the
// user gets the native share sheet. On unsupported platforms it falls
// through to copy-to-clipboard with the same status feedback as copyLink.
async function shareRoom(): Promise<void> {
  const code = ($("#room-code") as HTMLElement).textContent ?? "";
  if (!code) return;
  const url = shareLink(code);
  type Nav = Navigator & { share?: (data: { title?: string; text?: string; url?: string }) => Promise<void> };
  const nav = navigator as Nav;
  if (typeof nav.share === "function") {
    try {
      await nav.share({ title: "wisp", text: `Join me on wisp: ${code}`, url });
      return;
    } catch (err) {
      // AbortError = user cancelled the share sheet; treat as a no-op.
      if (err instanceof Error && err.name === "AbortError") return;
      // any other error: fall through to clipboard so the user still gets a link
    }
  }
  await copyLink();
}

function leaveRoom(): void {
  // Push a new history entry for the lobby URL before tearing the room
  // down. Pressing Back from the lobby afterwards lands on the old room
  // URL, which the popstate handler treats as a join request — so Back
  // really does take you back into the room you just left. Disconnect /
  // error paths flow through showLobby's replaceState instead, which
  // doesn't grow history.
  const u = new URL(location.href);
  if (u.searchParams.has("room")) {
    u.searchParams.delete("room");
    history.pushState(null, "", u.pathname + u.search);
  }
  room?.leave();
}

// initSettings wires the device pickers and the mic test button. Test mic
// acquires getUserMedia, populates device labels, and runs a level meter
// so the user can confirm their setup before joining.
function initSettings(): void {
  const inSel = document.querySelector<HTMLSelectElement>("#mic-select");
  const outSel = document.querySelector<HTMLSelectElement>("#speaker-select");
  const testBtn = document.querySelector<HTMLButtonElement>("#mic-test");
  const meterBar = document.querySelector<HTMLElement>("#mic-meter-bar");

  inSel?.addEventListener("change", () => {
    prefs.inputDeviceId = inSel.value;
    savePrefs();
    if (mic) void switchInputDevice();
  });

  outSel?.addEventListener("change", () => {
    prefs.outputDeviceId = outSel.value;
    savePrefs();
    void setOutputDevice(prefs.outputDeviceId);
  });

  if (testBtn && meterBar) {
    levelMeter = createMicLevelMeter(meterBar);
    let testActive = false;
    testBtn.addEventListener("click", async () => {
      if (testActive) {
        levelMeter?.stop();
        testActive = false;
        testBtn.textContent = "test mic";
        return;
      }
      try {
        const m = await ensureMic();
        levelMeter?.start(m.raw);
        testActive = true;
        testBtn.textContent = "stop test";
      } catch (err) {
        setLobbyError(formatError(err));
      }
    });
  }
}

// initRoomTabs wires the People / Chat tabs that only show on narrow
// viewports. The room is split into two panes there because stacking
// peers above a chat scroll is awkward — tabs let one fill the screen
// while the compose stays anchored at the bottom of the chat tab.
function initRoomTabs(): void {
  const room = document.querySelector<HTMLElement>("#room");
  const tabs = document.querySelectorAll<HTMLButtonElement>(".room-tabs button");
  if (!room || tabs.length === 0) return;

  const setTab = (name: string) => {
    room.classList.toggle("tab-users", name === "users");
    room.classList.toggle("tab-chat", name === "chat");
    tabs.forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
  };

  // Chat is the default — it's what most people want to glance at while
  // a call is running. Switching to Users is a deliberate "who's here?"
  // moment.
  setTab("chat");

  tabs.forEach((t) => {
    t.addEventListener("click", () => {
      const name = t.dataset.tab;
      if (name) setTab(name);
    });
  });
}

// initAudioPopover wires the gear button's open/close behavior. The
// popover is anchored under the gear in the site header so it persists
// across the lobby and room views — useful for switching mics mid-call.
function initAudioPopover(): void {
  const gear = document.querySelector<HTMLButtonElement>("#audio-gear");
  const pop = document.querySelector<HTMLElement>("#audio-popover");
  if (!gear || !pop) return;

  const setOpen = (open: boolean) => {
    pop.hidden = !open;
    gear.setAttribute("aria-expanded", open ? "true" : "false");
  };

  gear.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setOpen(pop.hidden);
  });

  // Click outside the popover (and not on the gear) closes it. We listen
  // on the document so the handler catches clicks anywhere in the app.
  document.addEventListener("click", (ev) => {
    if (pop.hidden) return;
    const target = ev.target as Node | null;
    if (target && (pop.contains(target) || gear.contains(target))) return;
    setOpen(false);
  });

  // Esc closes if the popover is open. We don't preventDefault on other
  // keys — Escape inside a select shouldn't close, but selects open as
  // native menus and intercept their own Escape handling first.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !pop.hidden) {
      setOpen(false);
      gear.focus();
    }
  });
}

// initScreenShare wires the header share button and the presenter pane.
// The button stays hidden until a Room is active (set in onJoined). The
// pane is created once and reused across rooms — its active/open state
// is driven by onPresenterChanged and the rail indicator click.
function initScreenShare(): void {
  presenterView = createPresenterView({
    onStopShare: () => {
      room?.stopShare();
    },
    onClose: () => {
      // The user dismissed the pane; the share itself keeps running and
      // the rail indicator stays so they can reopen it.
    },
    onAudioVolumeChange: (volume) => {
      // Independent of the per-peer mic mute. Volume is a linear gain
      // factor (0 = silent, 1 = unity, 2 = +6 dB boost) applied to the
      // AudioContext gain node attachRemoteStream installed.
      remoteScreenAudio?.setVolume(volume);
    },
  });
  screenShareBtn = bindScreenShareButton({
    onPick: (mode) => {
      if (!room) return;
      void room.startShare(mode).catch((err) => {
        console.error("startShare failed", err);
        setRoomStatus("Couldn't start sharing");
        setTimeout(() => setRoomStatus(""), 2500);
      });
    },
    onStop: () => {
      room?.stopShare();
    },
  });
  // Hidden by default; onJoined will reveal it when the browser supports
  // getDisplayMedia. iOS Safari users never see it.
  screenShareBtn.setVisible(false);
}

async function switchInputDevice(): Promise<void> {
  // Restart mic with the new device. We replace tracks on every existing
  // peer so audio continues without renegotiation. Self-VAD continues to
  // observe the (now-stopped) old raw track until the next room install,
  // which is harmless — a stopped track simply emits no speech transitions.
  const old = mic;
  mic = null;
  try {
    const next = await startMic({ deviceId: prefs.inputDeviceId });
    mic = next;
    room?.setOutboundTrack(next.outbound);
    old?.close();
  } catch (err) {
    console.error("switching mic failed", err);
    mic = old;
    setRoomStatus("Couldn't switch microphone");
    setTimeout(() => setRoomStatus(""), 2000);
  }
}

function init(): void {
  // Begin fetching DFN3 assets immediately so they're cached by the time
  // the user clicks Create/Join. The promise is reused inside startMic; if
  // it's still pending when the user clicks, startMic awaits it once.
  void preloadNoiseSuppression();

  initSettings();
  initAudioPopover();
  initRoomTabs();
  initScreenShare();
  diagnostics = bindDiagnostics({
    getSnapshot: () => room?.diagnostics() ?? null,
    kickReconnect: () => room?.kickReconnect(),
  });

  // Prefill the lobby name field from localStorage so a returning user
  // doesn't have to retype. Empty stored value falls through to the server's
  // animal-name fallback. The user can still edit before joining; submitting
  // the form with a non-empty name overwrites the stored value.
  const storedName = loadStoredName();
  if (storedName) ($("#name-input") as HTMLInputElement).value = storedName;

  // Empty name is sent verbatim; the server picks a random animal name as
  // the fallback. The user can edit before joining, or rename in-room.
  $("#create-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void startCreate();
  });
  $("#join-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const code = (($("#join-code") as HTMLInputElement).value ?? "").trim();
    void startJoin(code);
  });
  $("#leave-btn").addEventListener("click", leaveRoom);
  // Both share-or-copy buttons (rail-head on wide, site-header on narrow)
  // run shareRoom; it falls back to copyLink when the Web Share API isn't
  // available. The visible icon is swapped via CSS using body.share-supported.
  $("#copy-link").addEventListener("click", () => void shareRoom());
  document.querySelector<HTMLButtonElement>("#share-narrow")
    ?.addEventListener("click", () => void shareRoom());
  initShareSupport();
  bindChatComposer({
    onSend: (text) => room?.sendChat(text) ?? false,
    onEditSave: (id, text) => room?.editChat(id, text) ?? false,
  });
  bindChatMessageActions({
    onDelete: (id) => room?.deleteChat(id) ?? false,
  });
  $("#brand").addEventListener("click", (ev) => {
    if (!room) return;
    ev.preventDefault();
    leaveRoom();
  });

  // Listen for device changes (plug/unplug headphones) and refresh the
  // pickers so the user sees the current device list.
  navigator.mediaDevices?.addEventListener?.("devicechange", () => {
    void refreshDevicePickers();
  });

  // pagehide fires for refresh, tab close, and same-tab navigation. We stop
  // the mic explicitly so the OS recording indicator clears immediately
  // rather than waiting for the browser to garbage-collect the page.
  window.addEventListener("pagehide", () => {
    room?.leave();
    releaseMic();
  });

  // Sync room membership with the URL on Back/Forward. The URL has already
  // changed by the time popstate fires; we just align state to match.
  window.addEventListener("popstate", () => {
    const target = new URL(location.href).searchParams.get("room");
    if (target && target !== currentRoomCode()) {
      ($("#join-code") as HTMLInputElement).value = target;
      void startJoin(target);
    } else if (!target && room) {
      leaveRoom();
    }
  });

  // Pre-fill from ?room= and auto-join. If join fails, the lobby stays
  // visible with the code already filled in so the user can retry.
  const url = new URL(location.href);
  const preset = url.searchParams.get("room");
  if (preset) {
    ($("#join-code") as HTMLInputElement).value = preset;
    void startJoin(preset);
  }
}

function currentRoomCode(): string | null {
  if (!room) return null;
  return ($("#room-code") as HTMLElement).textContent || null;
}

init();
