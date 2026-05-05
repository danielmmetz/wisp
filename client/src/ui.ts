// DOM helpers for the lobby and room screens. Stays vanilla; no framework.

import { attachRemoteStream, observeMicLevel, observeSpeaking, type AudioDevice } from "./audio.ts";
import { MAX_NAME_LEN } from "./wire.ts";

export interface PeerRowOptions {
  id: string;
  name: string;
  // onMuteToggle fires with the new muted state when the user clicks the
  // mute button. Mutes playback of this peer's audio locally.
  onMuteToggle: (muted: boolean) => void;
}

export interface PeerRowHandle {
  id: string;
  el: HTMLLIElement;
  setName: (n: string) => void;
  setSpeaking: (s: boolean) => void;
  setQuality: (q: "good" | "degraded" | "poor" | "unknown") => void;
  setTransport: (t: "direct" | "relayed" | "unknown") => void;
  setMuted: (m: boolean) => void;
  setCipherHealth: (healthy: boolean) => void;
  attach: (stream: MediaStream) => void;
  destroy: () => void;
}

export interface SelfBlockOptions {
  name: string;
  onMuteToggle: (muted: boolean) => void;
  onRenameRequest: (name: string) => void;
  onLeaveRequest: () => void;
}

export interface SelfBlockHandle {
  setName: (n: string) => void;
  setSpeaking: (s: boolean) => void;
  setMuted: (m: boolean) => void;
  setQuality: (q: "good" | "degraded" | "poor" | "unknown") => void;
  reset: () => void;
}

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`element not found: ${sel}`);
  return el as HTMLElement;
}

export function showLobby(): void {
  ($("#lobby") as HTMLElement).hidden = false;
  ($("#room") as HTMLElement).hidden = true;
  document.body.classList.remove("in-room");
  const codeNarrow = document.querySelector<HTMLElement>("#room-code-narrow");
  if (codeNarrow) codeNarrow.textContent = "";
  const u = new URL(location.href);
  if (u.searchParams.has("room")) {
    u.searchParams.delete("room");
    history.replaceState(null, "", u.pathname + u.search);
  }
}

export function showRoom(code: string): void {
  ($("#lobby") as HTMLElement).hidden = true;
  ($("#room") as HTMLElement).hidden = false;
  ($("#room-code") as HTMLElement).textContent = code;
  document.body.classList.add("in-room");
  // The narrow site-header carries the room code (the rail-head is hidden
  // on narrow). Mirror it.
  const codeNarrow = document.querySelector<HTMLElement>("#room-code-narrow");
  if (codeNarrow) codeNarrow.textContent = code;
  // pushState so Back returns to the lobby. Skip when the URL already
  // matches (initial load via ?room=, or re-entry from a popstate handler).
  const u = new URL(location.href);
  if (u.searchParams.get("room") !== code) {
    u.searchParams.set("room", code);
    history.pushState(null, "", u.pathname + u.search);
  }
}

export function setLobbyError(msg: string | null): void {
  const el = $("#lobby-error") as HTMLElement;
  el.textContent = msg ?? "";
  el.hidden = !msg;
}

// The rail meta line carries either the current peer count ("4 peers") or
// a transient status ("Connecting…", "Reconnecting (attempt 2)…", "Link
// copied"). Status takes precedence; clearing status restores peer count.
let currentStatus = "";
let peerCount = 0;
function renderRailMeta(): void {
  // We mirror the meta into both the rail-head (wide) and the site-header
  // (narrow), so collect both elements once and apply the same logic.
  const els = [
    $("#room-status") as HTMLElement,
    document.querySelector<HTMLElement>("#room-status-narrow"),
  ].filter((x): x is HTMLElement => x !== null);
  for (const el of els) {
    el.classList.remove("is-count", "is-status");
    if (currentStatus) {
      el.textContent = currentStatus;
      el.classList.add("is-status");
      continue;
    }
    if (peerCount <= 0) { el.textContent = ""; continue; }
    el.textContent = peerCount === 1 ? "1 user" : `${peerCount} users`;
    // The count form is suppressed on narrow (the Users tab carries it).
    el.classList.add("is-count");
  }
}
export function setRoomStatus(msg: string): void {
  currentStatus = msg;
  renderRailMeta();
}
export function setPeerCount(n: number): void {
  peerCount = n;
  renderRailMeta();
  // Mirror the count into the Users tab label (visible on narrow viewports).
  const countEl = document.querySelector<HTMLElement>("#tab-users-count");
  if (countEl) countEl.textContent = n > 0 ? String(n) : "";
}

export function shareLink(code: string): string {
  const u = new URL(location.href);
  u.searchParams.set("room", code);
  return u.toString();
}

// fillDeviceSelect populates a <select> with audio devices, preserving
// the currently-selected ID where possible. "" maps to the system default,
// which is rendered as a leading "(system default)" option.
export function fillDeviceSelect(
  sel: HTMLSelectElement,
  devices: AudioDevice[],
  selected: string,
): void {
  const prev = selected || sel.value || "";
  sel.replaceChildren();
  const dflt = document.createElement("option");
  dflt.value = "";
  dflt.textContent = "(system default)";
  sel.appendChild(dflt);
  for (const d of devices) {
    const opt = document.createElement("option");
    opt.value = d.deviceId;
    opt.textContent = d.label;
    sel.appendChild(opt);
  }
  // Restore selection if the device is still present; otherwise keep default.
  if (devices.some((d) => d.deviceId === prev)) {
    sel.value = prev;
  } else {
    sel.value = "";
  }
}

// makePeerRow builds a row for a remote peer. Self lives in the rail-self
// block instead — see bindSelfBlock.
export function makePeerRow(opts: PeerRowOptions): PeerRowHandle {
  const tpl = document.querySelector<HTMLTemplateElement>("#peer-row");
  if (!tpl) throw new Error("peer-row template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const nameEl = node.querySelector<HTMLElement>(".nm")!;
  const transportEl = node.querySelector<HTMLElement>(".transport")!;
  const cipherEl = node.querySelector<HTMLElement>(".cipher")!;
  const volEl = node.querySelector<HTMLInputElement>(".vol")!;
  const muteBtn = node.querySelector<HTMLButtonElement>(".mute")!;

  nameEl.textContent = opts.name;

  let stopVAD: (() => void) | null = null;
  let detachAudio: (() => void) | null = null;
  let setVolumeFn: ((v: number) => void) | null = null;
  let currentQuality: "good" | "degraded" | "poor" | "unknown" = "unknown";

  const handle: PeerRowHandle = {
    id: opts.id,
    el: node,
    setName: (n) => { nameEl.textContent = n; },
    setSpeaking: (s) => node.classList.toggle("speaking", s),
    setQuality: (q) => {
      currentQuality = q;
      // Quality is implicit in normal operation; we only flag degraded /
      // poor by tinting the badge frame so the row stays calm at rest.
      node.classList.toggle("q-degraded", q === "degraded");
      node.classList.toggle("q-poor", q === "poor");
    },
    setTransport: (t) => {
      transportEl.classList.remove("relayed");
      if (t === "unknown") {
        transportEl.textContent = "";
        transportEl.title = "";
        return;
      }
      if (t === "relayed") transportEl.classList.add("relayed");
      transportEl.textContent = t === "relayed" ? "relay" : "wss";
      transportEl.title = t === "direct" ? "peer-to-peer" : "via TURN relay";
    },
    setMuted: (m) => {
      node.classList.toggle("is-muted", m);
      const label = m ? "Unmute" : "Mute";
      muteBtn.title = label;
      muteBtn.setAttribute("aria-label", label);
    },
    setCipherHealth: (healthy) => {
      if (healthy) {
        cipherEl.textContent = "";
        cipherEl.title = "";
        cipherEl.classList.remove("bad");
      } else {
        cipherEl.textContent = "⚠";
        cipherEl.title = "couldn't decrypt audio from this peer";
        cipherEl.classList.add("bad");
      }
    },
    attach: (s) => {
      // Close any prior playback / VAD so a re-attach (e.g. after the room
      // reconnects and a fresh ontrack fires for the same peer) doesn't
      // leak the previous audio element or analyser.
      detachAudio?.();
      stopVAD?.();
      const remote = attachRemoteStream(s);
      detachAudio = remote.close;
      setVolumeFn = remote.setVolume;
      const audioTrack = s.getAudioTracks()[0];
      if (audioTrack) {
        stopVAD = observeSpeaking(audioTrack, (speaking) => handle.setSpeaking(speaking));
      }
      remote.setVolume(Number(volEl.value) / 100);
    },
    destroy: () => {
      stopVAD?.();
      detachAudio?.();
      node.remove();
    },
  };

  muteBtn.addEventListener("click", () => {
    const next = !node.classList.contains("is-muted");
    handle.setMuted(next);
    opts.onMuteToggle(next);
  });
  volEl.addEventListener("input", () => {
    setVolumeFn?.(Number(volEl.value) / 100);
  });

  void currentQuality;
  return handle;
}

export function appendPeerRow(handle: PeerRowHandle): void {
  ($("#peers") as HTMLElement).appendChild(handle.el);
}

// bindSelfBlock hooks up the static self-only chrome — three places that
// reflect the same person:
//   - rail-self (wide footer): name + quality + mic + (no leave; that's
//     in the leave-btn next to mic on the wide rail-self too)
//   - site-header narrow controls: glyph + room code + mic + share + gear
//   - self peer row at the top of the Users list (narrow only): name with
//     click-to-rename + leave button
// All three update in sync; clicking any mic toggles the same mic state.
export function bindSelfBlock(opts: SelfBlockOptions): SelfBlockHandle {
  const nameEl = $("#self-name");
  const qmetaEl = $("#self-quality");
  const muteBtn = $("#self-mute") as HTMLButtonElement;
  const muteBtnNarrow = document.querySelector<HTMLButtonElement>("#self-mute-narrow");
  const peerRowName = document.querySelector<HTMLElement>("#self-peer-name");

  let currentName = opts.name;
  nameEl.textContent = currentName;
  if (peerRowName) peerRowName.textContent = currentName;
  qmetaEl.textContent = "";
  qmetaEl.classList.remove("degraded", "poor");
  muteBtn.classList.remove("is-muted");
  muteBtnNarrow?.classList.remove("is-muted");

  const handle: SelfBlockHandle = {
    setName: (n) => {
      currentName = n;
      // If a rename input is open in either spot, leave it alone.
      if (!nameEl.querySelector("input")) nameEl.textContent = n;
      if (peerRowName && !peerRowName.querySelector("input")) peerRowName.textContent = n;
    },
    setSpeaking: () => { /* self speaking indicator is intentionally absent */ },
    setMuted: (m) => {
      muteBtn.classList.toggle("is-muted", m);
      muteBtnNarrow?.classList.toggle("is-muted", m);
      const label = m ? "Unmute" : "Mute";
      for (const b of [muteBtn, muteBtnNarrow]) {
        if (!b) continue;
        b.title = label;
        b.setAttribute("aria-label", label);
      }
    },
    setQuality: (q) => {
      qmetaEl.classList.remove("degraded", "poor");
      if (q === "good") qmetaEl.textContent = "good";
      else if (q === "degraded") { qmetaEl.textContent = "degraded"; qmetaEl.classList.add("degraded"); }
      else if (q === "poor") { qmetaEl.textContent = "poor"; qmetaEl.classList.add("poor"); }
      else qmetaEl.textContent = "";
    },
    reset: () => {
      muteBtn.classList.remove("is-muted");
      muteBtnNarrow?.classList.remove("is-muted");
      qmetaEl.textContent = "";
      qmetaEl.classList.remove("degraded", "poor");
      nameEl.textContent = "";
      if (peerRowName) peerRowName.textContent = "";
    },
  };

  // Mute toggle: same handler regardless of which mic button was clicked.
  const onMuteClick = () => {
    const next = !muteBtn.classList.contains("is-muted");
    handle.setMuted(next);
    opts.onMuteToggle(next);
  };
  muteBtn.addEventListener("click", onMuteClick);
  muteBtnNarrow?.addEventListener("click", onMuteClick);

  // Click-to-rename. Wired on both name elements; the server's peer_renamed
  // broadcast is the source of truth for the displayed name.
  const wireRename = (target: HTMLElement) => {
    target.addEventListener("click", () => {
      if (target.querySelector("input")) return;
      startEdit(target);
    });
  };
  wireRename(nameEl);
  if (peerRowName) wireRename(peerRowName);

  // Leave button in the narrow site-header. The handler is the same as
  // the wide rail-self leave (and the brand-link Back behavior); main.ts
  // owns the actual leaveRoom call via opts.onLeaveRequest.
  document.querySelector<HTMLButtonElement>("#self-leave-narrow")
    ?.addEventListener("click", () => opts.onLeaveRequest());

  function startEdit(target: HTMLElement): void {
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.maxLength = MAX_NAME_LEN;
    input.className = "name-edit";
    target.replaceChildren(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next && next !== currentName) {
        opts.onRenameRequest(next);
      }
      target.textContent = currentName;
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      target.textContent = currentName;
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
  }

  return handle;
}

// formatTime renders a sender timestamp as HH:MM in the viewer's locale.
// Seconds are dropped — chat in this app is small enough that minute-level
// precision matches what the rest of the UI promises.
function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// appendChatMessage renders a message at the end of the chat scroll. There
// is no visual difference between self and peer messages — the user knows
// the name they're sending under, and the rail-bottom self-row anchors that.
//
// `from` is the author's peer ID (localId for self). It is stamped on the
// node as a data attribute so renameChatAuthor can rewrite history when
// a peer renames, and so consecutive messages from the same author can be
// detected and rendered without repeating the name + time.
export function appendChatMessage(opts: {
  from: string;
  name: string;
  body: string;
  ts: number;
}): void {
  const tpl = document.querySelector<HTMLTemplateElement>("#chat-message");
  if (!tpl) throw new Error("chat-message template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  node.dataset.from = opts.from;
  const who = node.querySelector<HTMLElement>(".who")!;
  who.textContent = opts.name;
  who.classList.add(`who-c${authorColorIndex(opts.from)}`);
  node.querySelector<HTMLElement>(".time")!.textContent = formatTime(opts.ts);
  node.querySelector<HTMLElement>(".body")!.textContent = opts.body;
  appendChatNode(node);
}

// Number of color slots defined in CSS (.who-c0 ... .who-cN-1). Keep in
// sync with style.css.
const AUTHOR_COLOR_SLOTS = 7;

// authorColorIndex maps a peer ID to a stable slot in [0, AUTHOR_COLOR_SLOTS).
// FNV-1a over the UTF-16 code units — collisions in a small room are
// possible but tolerable; the goal is "different from your neighbor",
// not a unique color per person.
function authorColorIndex(from: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < from.length; i++) {
    h ^= from.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % AUTHOR_COLOR_SLOTS;
}

// renameChatAuthor rewrites the displayed name on every existing chat
// message authored by `from`. Continuation rows hide the name via CSS, so
// this is a no-op visually for those.
export function renameChatAuthor(from: string, name: string): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  if (!list) return;
  for (const el of list.querySelectorAll<HTMLElement>(`.msg[data-from="${cssEscape(from)}"]`)) {
    const who = el.querySelector<HTMLElement>(".who");
    if (who) who.textContent = name;
  }
}

function cssEscape(s: string): string {
  // peer IDs are 16 hex chars from the server, but accept arbitrary input
  // defensively. Use the standard helper when available; otherwise fall
  // back to a conservative escape that handles the characters CSS needs.
  type CSSWithEscape = typeof CSS & { escape?: (s: string) => string };
  const fn = (CSS as CSSWithEscape).escape;
  if (typeof fn === "function") return fn.call(CSS, s);
  return s.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
}

export function appendChatSystem(text: string): void {
  const tpl = document.querySelector<HTMLTemplateElement>("#chat-system");
  if (!tpl) throw new Error("chat-system template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  node.textContent = text;
  appendChatNode(node);
}

export function clearChat(): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  list?.replaceChildren();
}

function appendChatNode(node: HTMLLIElement): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  if (!list) return;

  // Group consecutive messages from the same author by tagging this node
  // .continued — a system message between two messages from the same
  // author breaks the group. CSS hides the .who and .time on .continued
  // rows so the body flows as a paragraph.
  if (node.classList.contains("msg") && !node.classList.contains("system")) {
    const prev = list.lastElementChild as HTMLElement | null;
    if (prev && prev.classList.contains("msg") && !prev.classList.contains("system")) {
      const prevFrom = prev.dataset.from;
      const thisFrom = node.dataset.from;
      if (prevFrom && thisFrom && prevFrom === thisFrom) {
        node.classList.add("continued");
      }
    }
  }

  // "Near bottom" tolerance for sticky autoscroll. We can't always pin
  // (the user might be reading history) — only do it when they're close
  // enough to the tail that scroll movement won't be disorienting.
  const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
  const stick = distance < 80;
  list.appendChild(node);
  if (stick) list.scrollTop = list.scrollHeight;
}

// PresenterView controls the screen-share viewer plus the rail indicator
// that opens it. Two states are tracked independently:
//
//   - Active: there is a presenter (someone, possibly us). The rail
//     indicator shows their name; clicking it opens the pane.
//   - Open: the pane is rendering the stream. The chat column collapses.
//
// Pane open/close is user-driven (via the indicator and the close button).
// The pane never auto-opens on a new presenter — the indicator is the
// single entry point so a remote share never takes over the chat by
// surprise.
export interface PresenterInfo {
  name: string;
  stream: MediaStream | null;
  isSelf: boolean;
}
export interface PresenterView {
  // setActive records who the current presenter is (or null when nobody).
  // The indicator visibility and label follow from this; the pane updates
  // its content when open. Passing stream:null keeps the indicator visible
  // but the pane will render nothing until the stream arrives.
  setActive: (info: PresenterInfo | null) => void;
  // setOpen toggles the pane on/off. Independent of setActive — the pane
  // can be closed while a presenter is still active (indicator stays).
  setOpen: (open: boolean) => void;
  isOpen: () => boolean;
}
export function createPresenterView(opts: {
  onStopShare: () => void;
  onClose: () => void;
  // onAudioVolumeChange fires when the user moves the volume slider or
  // toggles the mute icon in the overlay. The value is a linear gain
  // factor in [0, 2] (0 = silent, 1 = unity, 2 = +6 dB boost). The view
  // tracks the value internally for icon state; the caller is responsible
  // for the actual playback gating (typically setVolume on the
  // AudioContext-routed audio handle).
  onAudioVolumeChange: (volume: number) => void;
}): PresenterView {
  const pane = document.querySelector<HTMLElement>("#presenter-pane");
  const video = document.querySelector<HTMLVideoElement>("#presenter-video");
  const stopBtn = document.querySelector<HTMLButtonElement>("#presenter-stop");
  const closeBtn = document.querySelector<HTMLButtonElement>("#presenter-close");
  const fsBtn = document.querySelector<HTMLButtonElement>("#presenter-fullscreen");
  const audioGroup = document.querySelector<HTMLElement>("#presenter-audio");
  const muteBtn = document.querySelector<HTMLButtonElement>("#presenter-audio-mute");
  const volSlider = document.querySelector<HTMLInputElement>("#presenter-audio-vol");
  const indicator = document.querySelector<HTMLButtonElement>("#presenter-indicator");
  const indicatorName = document.querySelector<HTMLElement>("#presenter-indicator-name");
  if (!pane || !video || !stopBtn || !closeBtn || !fsBtn || !audioGroup || !muteBtn || !volSlider || !indicator || !indicatorName) {
    throw new Error("presenter UI elements missing");
  }

  let active: PresenterInfo | null = null;
  let open = false;
  // volume is the current gain factor in [0, 2]. lastNonZero remembers
  // the level before the user muted, so unmuting via the icon restores
  // it instead of jumping back to 1.0.
  let volume = 1;
  let lastNonZero = 1;
  // Per-stream listeners for addtrack/removetrack so the volume cluster
  // reflects whether the active stream actually carries audio. When a
  // stream is replaced (or cleared), we detach these.
  let detachStreamListeners: (() => void) | null = null;

  const refreshAudioVisibility = () => {
    // The volume control only makes sense for remote streams that carry
    // audio. Self-preview never plays remote audio (we don't pipe our
    // own captured screen audio back) so the cluster stays hidden then.
    const hasAudio = !!active?.stream && active.stream.getAudioTracks().length > 0;
    const show = hasAudio && !!active && !active.isSelf;
    audioGroup.hidden = !show;
  };

  const applyVolume = (v: number, source: "icon" | "slider" | "reset") => {
    volume = Math.max(0, Math.min(2, v));
    if (volume > 0) lastNonZero = volume;
    const muted = volume === 0;
    muteBtn.classList.toggle("is-muted", muted);
    muteBtn.title = muted ? "Unmute screen audio" : "Mute screen audio";
    muteBtn.setAttribute("aria-label", muteBtn.title);
    // Avoid a feedback loop when the slider's own input event triggered
    // this — its value already reflects the new state.
    if (source !== "slider") volSlider.value = String(Math.round(volume * 100));
    if (source !== "reset") opts.onAudioVolumeChange(volume);
  };

  const watchStreamTracks = (stream: MediaStream | null) => {
    detachStreamListeners?.();
    detachStreamListeners = null;
    if (!stream) return;
    const onChange = () => refreshAudioVisibility();
    stream.addEventListener("addtrack", onChange);
    stream.addEventListener("removetrack", onChange);
    detachStreamListeners = () => {
      stream.removeEventListener("addtrack", onChange);
      stream.removeEventListener("removetrack", onChange);
    };
  };

  const renderPane = () => {
    if (!active) {
      video.srcObject = null;
      stopBtn.hidden = true;
      return;
    }
    stopBtn.hidden = !active.isSelf;
    // Re-assigning the same stream is a no-op; a different one swaps
    // cleanly. The video stays muted (autoplay-friendly + no echo for
    // self); remote system audio is wired separately by main.ts via
    // attachRemoteStream so the AudioContext output device applies.
    if (video.srcObject !== active.stream) {
      video.srcObject = active.stream;
      void video.play().catch(() => { /* autoplay edge cases */ });
    }
  };

  const renderOpen = () => {
    pane.hidden = !open;
    document.body.classList.toggle("presenter-open", open);
    if (open) renderPane();
  };

  const renderIndicator = () => {
    if (!active) {
      indicator.hidden = true;
      indicatorName.textContent = "";
      return;
    }
    indicator.hidden = false;
    indicatorName.textContent = active.isSelf ? "You're sharing" : active.name;
  };

  // Wire the indicator: clicking opens (or closes if already open).
  indicator.addEventListener("click", () => {
    open = !open;
    renderOpen();
  });
  closeBtn.addEventListener("click", () => {
    open = false;
    renderOpen();
    opts.onClose();
  });
  stopBtn.addEventListener("click", () => opts.onStopShare());
  muteBtn.addEventListener("click", () => {
    applyVolume(volume === 0 ? lastNonZero : 0, "icon");
  });
  volSlider.addEventListener("input", () => {
    applyVolume(Number(volSlider.value) / 100, "slider");
  });
  fsBtn.addEventListener("click", () => {
    type WithFS = HTMLElement & {
      requestFullscreen?: () => Promise<void>;
    };
    type DocWithFS = Document & {
      fullscreenElement?: Element | null;
      exitFullscreen?: () => Promise<void>;
    };
    const doc = document as DocWithFS;
    if (doc.fullscreenElement) {
      void doc.exitFullscreen?.();
    } else {
      void (pane as WithFS).requestFullscreen?.().catch((err) => {
        console.warn("requestFullscreen failed", err);
      });
    }
  });

  return {
    setActive: (info) => {
      // Reset volume to unity on any presenter change — fresh stream
      // gets a fresh default. Saves the user from inheriting a volume
      // tweak (or a mute) they don't remember setting. We pass "reset"
      // so this doesn't re-fire onAudioVolumeChange; the caller
      // re-attaches a fresh AudioContext gain node which already starts
      // at 1.0.
      const presenterChanged = !active || !info
        || active.stream !== info.stream
        || active.isSelf !== info.isSelf;
      if (presenterChanged) {
        lastNonZero = 1;
        applyVolume(1, "reset");
      }
      active = info;
      if (presenterChanged) watchStreamTracks(info?.stream ?? null);
      refreshAudioVisibility();
      renderIndicator();
      // If the pane is already open and the active presenter goes away,
      // close it; otherwise update content in place.
      if (!info && open) {
        open = false;
        renderOpen();
      } else if (open) {
        renderPane();
      }
    },
    setOpen: (next) => {
      open = next;
      renderOpen();
    },
    isOpen: () => open,
  };
}

// ScreenShareButton wraps the header share button: visibility, sharing
// state, and a tiny popover that asks the user to pick a mode before
// opening getDisplayMedia. The button is never disabled while a remote
// peer is sharing — clicking starts a takeover.
export interface ScreenShareButton {
  setVisible: (v: boolean) => void;
  setSharing: (sharing: boolean) => void;
}
export function bindScreenShareButton(opts: {
  onPick: (mode: "document" | "motion") => void;
  onStop: () => void;
}): ScreenShareButton {
  const btn = document.querySelector<HTMLButtonElement>("#screen-share");
  const pop = document.querySelector<HTMLElement>("#share-picker");
  const docBtn = document.querySelector<HTMLButtonElement>("#share-document");
  const motBtn = document.querySelector<HTMLButtonElement>("#share-motion");
  if (!btn || !pop || !docBtn || !motBtn) {
    throw new Error("screen-share UI elements missing");
  }
  let sharing = false;

  const setOpen = (open: boolean) => {
    pop.hidden = !open;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  };

  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    if (sharing) {
      opts.onStop();
      return;
    }
    setOpen(pop.hidden);
  });

  docBtn.addEventListener("click", () => {
    setOpen(false);
    opts.onPick("document");
  });
  motBtn.addEventListener("click", () => {
    setOpen(false);
    opts.onPick("motion");
  });

  document.addEventListener("click", (ev) => {
    if (pop.hidden) return;
    const target = ev.target as Node | null;
    if (target && (pop.contains(target) || btn.contains(target))) return;
    setOpen(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !pop.hidden) {
      setOpen(false);
      btn.focus();
    }
  });

  return {
    setVisible: (v) => { btn.hidden = !v; },
    setSharing: (s) => {
      sharing = s;
      btn.classList.toggle("is-sharing", s);
      btn.title = s ? "Stop sharing" : "Share screen";
      btn.setAttribute("aria-label", btn.title);
      if (s) setOpen(false);
    },
  };
}

// MicLevelMeter draws a small bar that follows the live mic input, used in
// the lobby so users can verify their selected mic before joining.
export interface MicLevelMeter {
  start: (track: MediaStreamTrack) => void;
  stop: () => void;
}
export function createMicLevelMeter(barEl: HTMLElement): MicLevelMeter {
  let stop: (() => void) | null = null;
  return {
    start: (track) => {
      stop?.();
      const release = observeMicLevel(track, (level) => {
        barEl.style.width = `${level * 100}%`;
      });
      stop = () => {
        release();
        barEl.style.width = "0%";
      };
    },
    stop: () => {
      stop?.();
      stop = null;
    },
  };
}
