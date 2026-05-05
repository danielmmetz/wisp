// Thin WebSocket wrapper over the signaling protocol. Reconnection is
// out of scope here — the room layer owns state and decides when to redial.

import type { ClientEnvelope, ServerEnvelope } from "./wire.ts";

export type ServerEventHandler = (env: ServerEnvelope) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private onEvent: ServerEventHandler;
  private onClose: () => void;

  constructor(onEvent: ServerEventHandler, onClose: () => void) {
    this.onEvent = onEvent;
    this.onClose = onClose;
  }

  // connect resolves once the socket is OPEN; rejects on early close.
  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
      ws.addEventListener("close", () => {
        if (this.ws === ws) {
          this.ws = null;
          this.onClose();
        }
      });
      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const env = JSON.parse(ev.data) as ServerEnvelope;
          this.onEvent(env);
        } catch (err) {
          console.error("bad signaling frame", err, ev.data);
        }
      });
    });
  }

  send(env: ClientEnvelope): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket not open");
    }
    ws.send(JSON.stringify(env));
  }

  close(): void {
    this.ws?.close(1000, "client closing");
    this.ws = null;
  }
}

// signalingURL builds the ws(s):// URL for the wisp server's /ws endpoint
// based on the current page origin. Useful when the server hosts both the
// SPA and the WebSocket on one origin (default deployment).
export function signalingURL(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/ws`;
}
