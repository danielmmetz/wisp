// Entrypoint. Wires lobby form → Room.create()/join(), and Room callbacks →
// the DOM helpers in ui.ts. No framework, no router; the URL ?room= param
// just pre-fills the join field and auto-submits.

import { startMic } from "./audio.ts";
import { Room } from "./room.ts";
import {
  $,
  appendPeerRow,
  makePeerRow,
  setLobbyError,
  setRoomStatus,
  shareLink,
  showLobby,
  showRoom,
} from "./ui.ts";
import type { MicCapture } from "./audio.ts";
import type { PeerRowHandle } from "./ui.ts";

let room: Room | null = null;
let mic: MicCapture | null = null;
const rows = new Map<string, PeerRowHandle>();
let qualityTimer: number | null = null;
let localId: string | null = null;

async function ensureMic(): Promise<MicCapture> {
  if (!mic) mic = await startMic();
  return mic;
}

function releaseMic(): void {
  mic?.close();
  mic = null;
}

function buildRoomCallbacks(): ConstructorParameters<typeof Room>[1] {
  return {
    onJoined: ({ code, localId: id, name }) => {
      localId = id;
      showRoom(code);
      setRoomStatus("Connecting…");
      const row = makePeerRow({
        id,
        name,
        isSelf: true,
        onMuteToggle: (m) => mic?.setMuted(m),
        onRenameRequest: (next) => {
          room?.rename(next);
        },
      });
      row.setQuality("unknown");
      rows.set(id, row);
      appendPeerRow(row);
      startQualityPolling();
    },
    onPeerAdded: (id, name) => {
      if (rows.has(id)) return;
      const row = makePeerRow({
        id,
        name,
        isSelf: false,
        onMuteToggle: (m) => {
          const stream = remoteStreams.get(id);
          if (stream) {
            for (const t of stream.getAudioTracks()) t.enabled = !m;
          }
        },
      });
      row.setQuality("unknown");
      rows.set(id, row);
      appendPeerRow(row);
    },
    onPeerRemoved: (id) => {
      rows.get(id)?.destroy();
      rows.delete(id);
      remoteStreams.delete(id);
    },
    onPeerRenamed: (id, name) => {
      rows.get(id)?.setName(name);
    },
    onRemoteStream: (id, stream) => {
      remoteStreams.set(id, stream);
      rows.get(id)?.attach(stream);
    },
    onSpeakingChange: (id, speaking) => {
      rows.get(id)?.setSpeaking(speaking);
    },
    onConnectionState: (id, state) => {
      const row = rows.get(id);
      if (!row) return;
      switch (state) {
        case "connected":
          setRoomStatus("");
          break;
        case "disconnected":
        case "failed":
          row.setQuality("poor");
          break;
      }
    },
    onLeft: (reason) => {
      stopQualityPolling();
      for (const r of rows.values()) r.destroy();
      rows.clear();
      remoteStreams.clear();
      localId = null;
      releaseMic();
      showLobby();
      setLobbyError(reason === "user left" ? null : `Disconnected: ${reason}`);
      room = null;
    },
    onError: (msg) => {
      setLobbyError(msg);
      stopQualityPolling();
      releaseMic();
      room = null;
    },
  };
}

const remoteStreams = new Map<string, MediaStream>();

function startQualityPolling(): void {
  stopQualityPolling();
  qualityTimer = window.setInterval(async () => {
    if (!room) return;
    let stats;
    try {
      stats = await room.peerStats();
    } catch (err) {
      console.warn("peerStats failed", err);
      return;
    }
    for (const [id, s] of stats) {
      rows.get(id)?.setTransport(s.transport ?? "unknown");
    }
  }, 2000);
}
function stopQualityPolling(): void {
  if (qualityTimer !== null) {
    window.clearInterval(qualityTimer);
    qualityTimer = null;
  }
}

function readNameFromLobby(): string {
  const raw = (($("#name-input") as HTMLInputElement).value ?? "").trim();
  return raw;
}

async function startCreate(): Promise<void> {
  setLobbyError(null);
  try {
    const m = await ensureMic();
    room = new Room(m, buildRoomCallbacks());
    await room.create(readNameFromLobby());
  } catch (err) {
    setLobbyError(err instanceof Error ? err.message : String(err));
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
    room = new Room(m, buildRoomCallbacks());
    await room.join(code, readNameFromLobby());
  } catch (err) {
    setLobbyError(err instanceof Error ? err.message : String(err));
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

function leaveRoom(): void {
  room?.leave();
}

function init(): void {
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
  $("#copy-link").addEventListener("click", () => void copyLink());
  $("#brand").addEventListener("click", (ev) => {
    if (!room) return;
    ev.preventDefault();
    leaveRoom();
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
