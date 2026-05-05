// DOM helpers for the lobby and room screens. Stays vanilla; no framework.

import { attachRemoteStream, observeSpeaking, type AudioDevice } from "./audio.ts";
import { MAX_NAME_LEN } from "./wire.ts";

export interface PeerRowOptions {
  id: string;
  name: string;
  isSelf: boolean;
  // onMuteToggle fires with the new muted state when the user clicks the
  // mute button. Self-rows mute outbound mic; remote rows mute playback.
  onMuteToggle: (muted: boolean) => void;
  // onRenameRequest fires when the user (self-row only) commits an edit
  // to their display name. The room layer round-trips through the server.
  onRenameRequest?: (name: string) => void;
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

export function $(sel: string): HTMLElement {
  const el = document.querySelector(sel);
  if (!el) throw new Error(`element not found: ${sel}`);
  return el as HTMLElement;
}

export function showLobby(): void {
  ($("#lobby") as HTMLElement).hidden = false;
  ($("#room") as HTMLElement).hidden = true;
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

export function setRoomStatus(msg: string): void {
  ($("#room-status") as HTMLElement).textContent = msg;
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

export function makePeerRow(opts: PeerRowOptions): PeerRowHandle {
  const tpl = document.querySelector<HTMLTemplateElement>("#peer-row");
  if (!tpl) throw new Error("peer-row template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const nameEl = node.querySelector<HTMLElement>(".name")!;
  const qualityEl = node.querySelector<HTMLElement>(".quality")!;
  const transportEl = node.querySelector<HTMLElement>(".transport")!;
  const cipherEl = node.querySelector<HTMLElement>(".cipher")!;
  const volEl = node.querySelector<HTMLInputElement>(".vol")!;
  const muteBtn = node.querySelector<HTMLButtonElement>(".mute")!;

  let currentName = opts.name;
  const renderName = (n: string) => {
    nameEl.textContent = opts.isSelf ? `${n} (you)` : n;
  };
  renderName(currentName);

  let stopVAD: (() => void) | null = null;
  let detachAudio: (() => void) | null = null;
  let setVolumeFn: ((v: number) => void) | null = null;

  const handle: PeerRowHandle = {
    id: opts.id,
    el: node,
    setName: (n) => {
      currentName = n;
      renderName(n);
    },
    setSpeaking: (s) => node.classList.toggle("speaking", s),
    setQuality: (q) => {
      qualityEl.classList.remove("good", "degraded", "poor", "unknown");
      qualityEl.classList.add(q);
      qualityEl.title = `connection: ${q}`;
    },
    setTransport: (t) => {
      transportEl.classList.remove("direct", "relayed");
      if (t === "unknown") {
        transportEl.textContent = "";
        transportEl.title = "";
        return;
      }
      transportEl.classList.add(t);
      transportEl.textContent = t;
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
  if (opts.isSelf) {
    volEl.style.visibility = "hidden";
    nameEl.classList.add("editable");
    nameEl.title = "Click to rename";
    nameEl.addEventListener("click", () => {
      if (nameEl.querySelector("input")) return;
      startEdit();
    });
  }

  function startEdit(): void {
    if (!opts.onRenameRequest) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = currentName;
    input.maxLength = MAX_NAME_LEN;
    input.className = "name-edit";
    nameEl.replaceChildren(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      if (next && next !== currentName) {
        opts.onRenameRequest!(next);
      }
      // Restore the current name; the server's peer_renamed broadcast
      // (or its absence) drives the final state.
      renderName(currentName);
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      renderName(currentName);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); commit(); }
      else if (ev.key === "Escape") { ev.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
  }

  return handle;
}

export function appendPeerRow(handle: PeerRowHandle): void {
  ($("#peers") as HTMLElement).appendChild(handle.el);
}

// prependPeerRow inserts handle at the top of the peers list. Used for the
// local peer so "you" always sits above the rest, regardless of whether
// onJoined fires before or after the existing-peers walk on initial join.
export function prependPeerRow(handle: PeerRowHandle): void {
  const list = $("#peers") as HTMLElement;
  list.insertBefore(handle.el, list.firstChild);
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

// appendChatMessage renders a message at the end of the chat scroll. self
// flag picks the lighter accent bubble. The scroll auto-pins to the bottom
// when the user is already at (or near) the bottom; if they have scrolled
// up to read history, we leave their position alone.
//
// `from` is the author's peer ID (localId for self). It is stamped on the
// node as a data attribute so renameChatAuthor can rewrite history when
// a peer renames — chat bubbles always reflect the current name, not the
// name in effect when the message was sent.
export function appendChatMessage(opts: {
  from: string;
  name: string;
  body: string;
  ts: number;
  self: boolean;
}): void {
  const tpl = document.querySelector<HTMLTemplateElement>("#chat-message");
  if (!tpl) throw new Error("chat-message template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  if (opts.self) {
    node.classList.add("self");
    node.dataset.self = "1";
  }
  node.dataset.from = opts.from;
  node.querySelector<HTMLElement>(".who")!.textContent = formatWho(opts.name, opts.self);
  node.querySelector<HTMLElement>(".time")!.textContent = formatTime(opts.ts);
  node.querySelector<HTMLElement>(".body")!.textContent = opts.body;
  appendChatNode(node);
}

function formatWho(name: string, self: boolean): string {
  return self ? `${name} (you)` : name;
}

// renameChatAuthor rewrites the displayed name on every existing chat
// bubble authored by `from`. No-op when there are no past messages from
// that peer.
export function renameChatAuthor(from: string, name: string): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  if (!list) return;
  for (const el of list.querySelectorAll<HTMLElement>(`.msg[data-from="${cssEscape(from)}"]`)) {
    const self = el.dataset.self === "1";
    const who = el.querySelector<HTMLElement>(".who");
    if (who) who.textContent = formatWho(name, self);
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
  node.querySelector<HTMLElement>(".body")!.textContent = `— ${text} —`;
  appendChatNode(node);
}

export function clearChat(): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  list?.replaceChildren();
}

function appendChatNode(node: HTMLLIElement): void {
  const list = document.querySelector<HTMLElement>("#chat-messages");
  if (!list) return;
  // "Near bottom" tolerance for sticky autoscroll. We can't always pin
  // (the user might be reading history) — only do it when they're close
  // enough to the tail that scroll movement won't be disorienting.
  const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
  const stick = distance < 80;
  list.appendChild(node);
  if (stick) list.scrollTop = list.scrollHeight;
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
      // Reuse observeSpeaking's analyser pipeline by attaching a separate
      // raf loop; observeSpeaking only emits transitions, but we want a
      // continuous level. Inline the analyser here for simplicity.
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let raf = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const rms = Math.sqrt(sum / buf.length);
        // Map -60dB..-10dB to 0..100%.
        const db = 20 * Math.log10(rms || 1e-9);
        const pct = Math.max(0, Math.min(1, (db + 60) / 50)) * 100;
        barEl.style.width = `${pct}%`;
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      stop = () => {
        cancelAnimationFrame(raf);
        source.disconnect();
        void ctx.close();
        barEl.style.width = "0%";
      };
    },
    stop: () => {
      stop?.();
      stop = null;
    },
  };
}
