// Connection-diagnostics panel: a self-debug surface for users stuck at
// "Connecting…". Owns the dialog DOM, the refresh-while-open timer, and
// the auto-open behavior when the room has been stuck >10s.
//
// Stays decoupled from Room: the caller passes a getSnapshot() function so
// this module never imports Room directly. The same getSnapshot is reused
// for the live refresh and for the "Copy diagnostics" payload.

import type { Diagnostics } from "./room.ts";

interface DiagnosticsHandlers {
  getSnapshot: () => Promise<Diagnostics> | null;
  kickReconnect: () => void;
}

export interface DiagnosticsController {
  // open shows the panel and starts the refresh loop.
  open: () => void;
  // close hides the panel and stops the refresh loop.
  close: () => void;
  // setStuckHint tells the panel whether the room is currently in a
  // "stuck" state (connecting/reconnecting). The panel uses this to:
  //  - pulse the trigger after 10s
  //  - auto-open at 10s (unless the user dismissed it this session)
  // Calling with the same value repeatedly is a no-op.
  setStuckHint: (stuck: boolean) => void;
  // reset clears the dismissed flag and stuck timer. Called on leave so a
  // future room starts with a clean slate.
  reset: () => void;
}

// AUTO_OPEN_MS is how long we wait in a stuck state before opening the
// panel ourselves. Long enough to not interrupt a normal join (most peers
// connect in 1–3s) but short enough that a confused user gets help before
// they refresh in frustration.
const AUTO_OPEN_MS = 10_000;
const REFRESH_MS = 1_000;

export function bindDiagnostics(handlers: DiagnosticsHandlers): DiagnosticsController {
  const dialog = document.querySelector<HTMLElement>("#diag-dialog");
  const body = document.querySelector<HTMLElement>("#diag-body");
  const sub = document.querySelector<HTMLElement>("#diag-sub");
  const closeBtn = document.querySelector<HTMLButtonElement>("#diag-close");
  const copyBtn = document.querySelector<HTMLButtonElement>("#diag-copy");
  const reconnectBtn = document.querySelector<HTMLButtonElement>("#diag-reconnect");
  const triggers = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".diag-trigger"),
  );
  if (!dialog || !body || !sub || !closeBtn || !copyBtn || !reconnectBtn) {
    // Missing markup — silently no-op so the rest of the app keeps working.
    return {
      open: () => {},
      close: () => {},
      setStuckHint: () => {},
      reset: () => {},
    };
  }

  let refreshTimer: number | null = null;
  let autoOpenTimer: number | null = null;
  let pulseTimer: number | null = null;
  let stuck = false;
  // userDismissed prevents auto-reopen after the user closed the panel
  // themselves. Cleared when stuck transitions false → true again, so a
  // *new* stuck event still surfaces the panel.
  let userDismissed = false;
  let lastSnapshot: Diagnostics | null = null;

  const setExpanded = (open: boolean): void => {
    for (const t of triggers) t.setAttribute("aria-expanded", open ? "true" : "false");
  };

  const tick = async (): Promise<void> => {
    const p = handlers.getSnapshot();
    if (!p) return;
    let snap: Diagnostics;
    try {
      snap = await p;
    } catch (err) {
      console.warn("diagnostics snapshot failed", err);
      return;
    }
    lastSnapshot = snap;
    renderInto(body, sub, snap);
    reconnectBtn.hidden = snap.status === "connected" || snap.status === "left";
  };

  const open = (): void => {
    if (!dialog.hidden) return;
    dialog.hidden = false;
    setExpanded(true);
    closeBtn.focus();
    void tick();
    if (refreshTimer === null) {
      refreshTimer = window.setInterval(() => void tick(), REFRESH_MS);
    }
  };

  const close = (): void => {
    if (dialog.hidden) return;
    dialog.hidden = true;
    setExpanded(false);
    if (refreshTimer !== null) {
      window.clearInterval(refreshTimer);
      refreshTimer = null;
    }
    // Reset the copy-button affordance so the next open starts fresh.
    copyBtn.classList.remove("copied");
    const lbl = copyBtn.querySelector<HTMLElement>(".copy-label");
    if (lbl) lbl.textContent = "Copy diagnostics";
  };

  const setStuckHint = (next: boolean): void => {
    if (next === stuck) return;
    stuck = next;
    if (autoOpenTimer !== null) {
      window.clearTimeout(autoOpenTimer);
      autoOpenTimer = null;
    }
    if (pulseTimer !== null) {
      window.clearTimeout(pulseTimer);
      pulseTimer = null;
    }
    if (!stuck) {
      for (const t of triggers) t.classList.remove("attention");
      return;
    }
    // Fresh stuck event: a user who dismissed the panel last time gets
    // another chance to see it.
    userDismissed = false;
    pulseTimer = window.setTimeout(() => {
      for (const t of triggers) t.classList.add("attention");
    }, AUTO_OPEN_MS);
    autoOpenTimer = window.setTimeout(() => {
      if (userDismissed) return;
      open();
    }, AUTO_OPEN_MS);
  };

  const reset = (): void => {
    setStuckHint(false);
    userDismissed = false;
    lastSnapshot = null;
    close();
  };

  // ---- handlers ----
  for (const t of triggers) {
    t.addEventListener("click", () => {
      if (dialog.hidden) {
        open();
      } else {
        userDismissed = true;
        close();
      }
    });
  }
  closeBtn.addEventListener("click", () => {
    userDismissed = true;
    close();
  });
  // Backdrop click closes (clicking inside .diag-card does not bubble to
  // the dialog because we stop propagation there).
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) {
      userDismissed = true;
      close();
    }
  });
  // Esc closes from anywhere.
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !dialog.hidden) {
      userDismissed = true;
      close();
    }
  });
  copyBtn.addEventListener("click", () => {
    void copyDiagnostics(copyBtn, lastSnapshot, handlers.getSnapshot);
  });
  reconnectBtn.addEventListener("click", () => {
    handlers.kickReconnect();
    // The room will hop through reconnecting → connecting → connected.
    // Keep the panel open so the user sees state change in real time.
  });

  return { open, close, setStuckHint, reset };
}

// renderInto rewrites the panel body in place. Cheap to call every second
// because the structure is small (one section + a few peer cards) and we
// rebuild from scratch — no diffing.
function renderInto(body: HTMLElement, sub: HTMLElement, snap: Diagnostics): void {
  sub.textContent = headerSubtitle(snap);
  body.replaceChildren(
    serverSection(snap),
    peersSection(snap),
    localSection(snap),
    ...tipFor(snap),
  );
}

function headerSubtitle(snap: Diagnostics): string {
  const elapsed = elapsedSince(snap.intentStartedAt, snap.capturedAt);
  switch (snap.status) {
    case "left":
      return "Not in a room";
    case "reconnecting":
      return `Reconnecting · attempt ${snap.reconnectAttempt}${
        elapsed ? ` · ${elapsed}` : ""
      }`;
    case "connecting":
      return `Connecting${elapsed ? ` · ${elapsed}` : ""}`;
    case "connected":
      return `Connected${elapsed ? ` · ${elapsed}` : ""}`;
  }
}

function serverSection(snap: Diagnostics): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "diag-section";
  sec.appendChild(h3("Server"));

  // WebSocket
  const wsRow = row(
    pip(snap.ws === "open" ? "good" : snap.ws === "connecting" ? "warn" : "bad"),
    "WebSocket",
    snap.ws === "open"
      ? "open"
      : snap.ws === "connecting"
        ? "connecting"
        : snap.status === "reconnecting"
          ? `reconnecting · attempt ${snap.reconnectAttempt}`
          : "closed",
  );
  sec.appendChild(wsRow);

  // TURN
  const turnText = snap.turn.received
    ? turnSummary(snap.turn.uris.length, snap.turn.ttlSecondsRemaining)
    : "missing";
  const turnPip = pip(
    snap.turn.received
      ? snap.turn.ttlSecondsRemaining !== null && snap.turn.ttlSecondsRemaining < 60
        ? "warn"
        : "good"
      : "bad",
  );
  sec.appendChild(row(turnPip, "TURN credentials", turnText));

  return sec;
}

function turnSummary(count: number, ttlSec: number | null): string {
  let s = `received · ${count} URI${count === 1 ? "" : "s"}`;
  if (ttlSec === null) return s;
  s += ` · ${formatTtl(ttlSec)} left`;
  return s;
}

function formatTtl(seconds: number): string {
  if (seconds <= 0) return "expired";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function peersSection(snap: Diagnostics): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "diag-section";
  sec.appendChild(h3("Peers"));
  if (snap.peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "diag-row";
    empty.innerHTML = `<span></span><span class="k">No other peers in the room yet.</span><span class="v"></span>`;
    sec.appendChild(empty);
    return sec;
  }
  for (const p of snap.peers) sec.appendChild(peerCard(p));
  return sec;
}

function peerCard(p: Diagnostics["peers"][number]): HTMLElement {
  const card = document.createElement("div");
  card.className = "diag-peer";

  const head = document.createElement("div");
  head.className = "diag-peer-head";
  const nameEl = document.createElement("span");
  nameEl.className = "diag-peer-name";
  nameEl.textContent = p.name || "(unnamed)";
  head.appendChild(nameEl);
  head.appendChild(stateTag(p));
  card.appendChild(head);

  const dl = document.createElement("dl");
  appendDt(dl, "ICE", iceSummary(p));
  appendDt(dl, "Transport", transportSummary(p));
  appendDt(dl, "Candidates", candidatesSummary(p));
  if (typeof p.rttMs === "number") {
    appendDt(dl, "RTT", `${Math.round(p.rttMs)} ms`);
  }
  card.appendChild(dl);
  return card;
}

// candidatesSummary renders things like:
//   host, srflx (no relay yet)
//   host only (no srflx, no relay)
//   host, srflx, relay
function candidatesSummary(p: Diagnostics["peers"][number]): HTMLElement {
  const span = document.createElement("span");
  const local = new Set(p.localCandidateTypes);
  const remote = new Set(p.remoteCandidateTypes);
  const all = new Set<string>([...local, ...remote]);
  if (all.size === 0) {
    span.innerHTML = `<span class="sub">none yet</span>`;
    return span;
  }
  const order = ["host", "srflx", "prflx", "relay"];
  const present = order.filter((t) => all.has(t));
  const html = present
    .map((t) => `<code>${t}</code>`)
    .join(", ");
  // Note absences that matter: no srflx ⇒ STUN didn't return; no relay ⇒
  // no path through TURN.
  const missing: string[] = [];
  if (!all.has("srflx")) missing.push("no srflx");
  if (!all.has("relay")) missing.push("no relay");
  span.innerHTML = missing.length
    ? `${html} <span class="sub">(${missing.join(", ")})</span>`
    : html;
  return span;
}

function iceSummary(p: Diagnostics["peers"][number]): string {
  // iceConnectionState is more granular than connectionState mid-connection
  // (it has "checking" before "connected"); we surface that, with the
  // age tacked on while still pre-connected.
  if (p.connectionState === "connected") return "connected";
  return `${p.iceConnectionState} · ${formatAge(p.ageMs)}`;
}

function transportSummary(p: Diagnostics["peers"][number]): HTMLElement {
  const span = document.createElement("span");
  if (p.transport === "unknown") {
    span.innerHTML = `<span class="sub">— not yet selected</span>`;
    return span;
  }
  const note = p.transport === "relayed" ? "via TURN relay" : "peer-to-peer";
  span.innerHTML = `${p.transport} <span class="sub">(${note})</span>`;
  return span;
}

function stateTag(p: Diagnostics["peers"][number]): HTMLElement {
  const tag = document.createElement("span");
  tag.className = "diag-state-tag";
  if (p.connectionState === "connected") {
    tag.classList.add(p.transport === "relayed" ? "warn" : "good");
    tag.textContent = p.transport === "relayed" ? "relayed" : "direct";
    return tag;
  }
  if (p.connectionState === "failed" || p.iceConnectionState === "failed") {
    tag.classList.add("bad");
    tag.textContent = "failed";
    return tag;
  }
  if (p.connectionState === "disconnected" || p.iceConnectionState === "disconnected") {
    tag.classList.add("bad");
    tag.textContent = "disconnected";
    return tag;
  }
  tag.classList.add("warn");
  tag.textContent = p.iceConnectionState === "checking" ? "checking" : p.connectionState;
  return tag;
}

function localSection(snap: Diagnostics): HTMLElement {
  const sec = document.createElement("section");
  sec.className = "diag-section";
  sec.appendChild(h3("Local"));
  sec.appendChild(row(blank(), "Browser", browserLabel(snap.local.userAgent)));
  sec.appendChild(row(blank(), "Online", snap.local.onLine ? "yes" : "no"));
  if (snap.intentStartedAt !== null) {
    const t = new Date(snap.intentStartedAt);
    const time = t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const peerSuffix = snap.localId ? ` · peer ${shortId(snap.localId)}` : "";
    sec.appendChild(row(blank(), "Joined", `${time}${peerSuffix}`));
  }
  return sec;
}

// ---- tip selection: the "what can the user do" rules ----

function tipFor(snap: Diagnostics): HTMLElement[] {
  // Server-side problems take precedence — telling a user to switch wifi
  // when the server is broken is unhelpful.
  if (snap.status === "left") return [];
  if (snap.ws === "closed" && snap.status === "reconnecting") {
    return [
      tip(
        "bad",
        "✕",
        `<strong>Lost connection to the wisp server.</strong> Reconnecting (attempt ${snap.reconnectAttempt}). If this keeps failing, your network may be blocking WebSockets — try a different network or disable any VPN.`,
      ),
    ];
  }
  if (!snap.turn.received) {
    // TURN is server-side. Show a tip even when we're "connected" alone or
    // pairwise — the next joiner with restrictive NAT will fail. Tone the
    // urgency to whether we're already connected.
    const hasConnectedPeer = snap.peers.some((p) => p.connectionState === "connected");
    if (!hasConnectedPeer) {
      return [
        tip(
          "bad",
          "✕",
          "<strong>The wisp server didn't issue TURN credentials.</strong> This is a server problem — refreshing won't help. If you host this room, check the server logs; otherwise let whoever runs it know.",
        ),
      ];
    }
    return [
      tip(
        "warn",
        "⚠",
        "<strong>No TURN relay available.</strong> Current peers connected directly, but anyone with a restrictive NAT joining later may fail to connect. Server-side issue.",
      ),
    ];
  }

  // Per-peer failures — pick the first peer that has an actionable problem.
  for (const p of snap.peers) {
    if (
      p.connectionState === "failed" &&
      p.remoteCandidateTypes.length === 0
    ) {
      return [
        tip(
          "warn",
          "⚠",
          `<strong>${escapeHtml(p.name || "Other peer")}'s side hasn't sent any ICE candidates.</strong> Their network is blocking peer connections. Easiest fix is for them to switch network — a phone hotspot is the fastest test.`,
        ),
      ];
    }
    if (
      p.iceConnectionState === "checking" &&
      p.ageMs > AUTO_OPEN_MS &&
      !p.localCandidateTypes.includes("relay") &&
      !p.remoteCandidateTypes.includes("relay")
    ) {
      return [
        tip(
          "warn",
          "⚠",
          `<strong>Stuck connecting to ${escapeHtml(p.name || "this peer")}.</strong> No relay candidate is available — TURN may be blocked on one side. Try switching network or disabling VPN, then click Reconnect.`,
        ),
      ];
    }
  }

  // All-good summary.
  if (snap.status === "connected" && snap.peers.length > 0) {
    const relayed = snap.peers.filter((p) => p.transport === "relayed");
    if (relayed.length > 0) {
      const names = relayed.map((p) => escapeHtml(p.name || "a peer")).join(", ");
      return [
        tip(
          "good",
          "✓",
          `Everything's connected. ${names} ${relayed.length === 1 ? "is" : "are"} going through a TURN relay — fine, but adds latency.`,
        ),
      ];
    }
    return [tip("good", "✓", "Everything's connected directly.")];
  }

  return [];
}

// ---- copy-to-clipboard ----

async function copyDiagnostics(
  btn: HTMLButtonElement,
  cached: Diagnostics | null,
  getSnapshot: () => Promise<Diagnostics> | null,
): Promise<void> {
  let snap = cached;
  if (!snap) {
    const p = getSnapshot();
    if (p) {
      try {
        snap = await p;
      } catch {
        snap = null;
      }
    }
  }
  if (!snap) return;
  const payload = JSON.stringify(snap, null, 2);
  try {
    await navigator.clipboard.writeText(payload);
    btn.classList.add("copied");
    const lbl = btn.querySelector<HTMLElement>(".copy-label");
    if (lbl) lbl.textContent = "Copied";
    window.setTimeout(() => {
      btn.classList.remove("copied");
      if (lbl) lbl.textContent = "Copy diagnostics";
    }, 1800);
  } catch (err) {
    console.warn("clipboard write failed", err);
  }
}

// ---- DOM helpers ----

function h3(text: string): HTMLElement {
  const el = document.createElement("h3");
  el.textContent = text;
  return el;
}

function row(pipEl: HTMLElement, key: string, value: string | HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "diag-row";
  r.appendChild(pipEl);
  const k = document.createElement("span");
  k.className = "k";
  k.textContent = key;
  r.appendChild(k);
  const v = document.createElement("span");
  v.className = "v";
  if (typeof value === "string") v.textContent = value;
  else v.appendChild(value);
  r.appendChild(v);
  return r;
}

function pip(kind: "good" | "warn" | "bad" | "muted"): HTMLElement {
  const el = document.createElement("span");
  el.className = `diag-pip ${kind === "muted" ? "" : kind}`.trim();
  return el;
}

function blank(): HTMLElement {
  // Empty placeholder for the pip column on rows that don't carry status.
  const el = document.createElement("span");
  return el;
}

function appendDt(dl: HTMLElement, k: string, v: string | HTMLElement): void {
  const dt = document.createElement("dt");
  dt.textContent = k;
  dl.appendChild(dt);
  const dd = document.createElement("dd");
  if (typeof v === "string") dd.textContent = v;
  else dd.appendChild(v);
  dl.appendChild(dd);
}

function tip(kind: "good" | "warn" | "bad", icon: string, html: string): HTMLElement {
  const t = document.createElement("div");
  t.className = `diag-tip ${kind}`;
  t.innerHTML = `<span class="ic">${icon}</span><div>${html}</div>`;
  return t;
}

function elapsedSince(start: number | null, now: number): string {
  if (start === null) return "";
  const sec = Math.max(0, Math.round((now - start) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function formatAge(ms: number): string {
  return elapsedSince(Date.now() - ms, Date.now());
}

function shortId(id: string): string {
  return id.length > 6 ? `${id.slice(0, 6)}…` : id;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function browserLabel(ua: string): string {
  // Coarse detection — enough for diagnostics, no need for a UA library.
  let browser = "Unknown";
  let version = "";
  // Order matters: Edge contains "Chrome", Chrome contains "Safari", etc.
  const matchers: Array<[string, RegExp]> = [
    ["Edge", /Edg\/([\d.]+)/],
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of matchers) {
    const m = ua.match(re);
    if (m) { browser = name; version = m[1] ?? ""; break; }
  }
  let os = "Unknown OS";
  if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/(iPhone|iPad|iPod)/.test(ua)) os = "iOS";
  else if (/Linux/.test(ua)) os = "Linux";
  const major = version.split(".")[0] ?? "";
  return `${browser}${major ? ` ${major}` : ""} · ${os}`;
}
