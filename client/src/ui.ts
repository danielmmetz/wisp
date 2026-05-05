// DOM helpers for the lobby and room screens. Stays vanilla; no framework.

import { attachRemoteStream, observeSpeaking } from "./audio.ts";
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

export function makePeerRow(opts: PeerRowOptions): PeerRowHandle {
  const tpl = document.querySelector<HTMLTemplateElement>("#peer-row");
  if (!tpl) throw new Error("peer-row template missing");
  const node = tpl.content.firstElementChild!.cloneNode(true) as HTMLLIElement;
  const nameEl = node.querySelector<HTMLElement>(".name")!;
  const qualityEl = node.querySelector<HTMLElement>(".quality")!;
  const transportEl = node.querySelector<HTMLElement>(".transport")!;
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
      node.classList.toggle("muted", m);
      muteBtn.textContent = m ? "unmute" : "mute";
    },
    attach: (s) => {
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
    const next = !node.classList.contains("muted");
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
