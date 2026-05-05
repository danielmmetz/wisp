// Entrypoint. Wires lobby form → Room.create()/join(), and Room callbacks →
// the DOM helpers in ui.ts. No framework, no router; the URL ?room= param
// just pre-fills the join field and auto-submits.

import {
  listAudioDevices,
  preloadNoiseSuppression,
  setOutputDevice,
  startMic,
  type AudioDevice,
} from "./audio.ts";
import { Room } from "./room.ts";
import {
  $,
  appendPeerRow,
  createMicLevelMeter,
  fillDeviceSelect,
  makePeerRow,
  setLobbyError,
  setRoomStatus,
  shareLink,
  showLobby,
  showRoom,
} from "./ui.ts";
import type { MicCapture } from "./audio.ts";
import type { PeerStats } from "./peer.ts";
import type { PeerRowHandle, MicLevelMeter } from "./ui.ts";

let room: Room | null = null;
let mic: MicCapture | null = null;
const rows = new Map<string, PeerRowHandle>();
let qualityTimer: number | null = null;
let localId: string | null = null;

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

let levelMeter: MicLevelMeter | null = null;

async function ensureMic(): Promise<MicCapture> {
  if (!mic) {
    mic = await startMic({ deviceId: prefs.inputDeviceId });
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
    onCipherHealth: (id, healthy) => {
      rows.get(id)?.setCipherHealth(healthy);
    },
    onReconnecting: (attempt) => {
      setRoomStatus(`Reconnecting (attempt ${attempt})…`);
      // Visually mark all peer rows as poor while the room is in limbo.
      for (const r of rows.values()) r.setQuality("poor");
    },
    onReconnected: () => {
      setRoomStatus("");
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
    room.applyAdaptiveBitrate(stats);
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
  const loss = s.lossRate;
  const rtt = s.rttMs;
  if (typeof loss !== "number" || !Number.isFinite(loss)) return "unknown";
  if (loss >= 0.05 || (rtt !== undefined && rtt > 400)) return "poor";
  if (loss >= 0.02 || (rtt !== undefined && rtt > 200)) return "degraded";
  return "good";
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
        setLobbyError(err instanceof Error ? err.message : String(err));
      }
    });
  }
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
