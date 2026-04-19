// ============================================================================
// upstream.ts — Singleton WebSocket client to the C++ backend.
//
// Architecture:
//   browser  ──fetch /api/shock──►  Next.js  ──ws://localhost:8080──►  C++
//   browser  ◄── SSE /api/stream ── Next.js  ◄────────────────────────  C++
//
// The browser never opens a raw WebSocket. It always talks to its own
// origin (Next.js on :3000), so the only network hop the user's machine
// has to forward is the page-loading port. The Node.js server inside
// Next.js opens ONE persistent WebSocket to the C++ backend at
// localhost:8080 and fans out incoming binary frames to every connected
// SSE client as base64 events.
// ============================================================================

import WebSocket from 'ws';

const BACKEND_WS_URL =
  process.env.OPTIRISK_BACKEND_WS_URL || 'ws://localhost:8080';

type FrameSink = (frame: Buffer) => void;

class UpstreamBridge {
  private ws: WebSocket | null = null;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoffMs = 500;
  private sinks = new Set<FrameSink>();
  private lastMsgAt = 0;

  // Most recent backend status — for debugging / health endpoints.
  status: 'idle' | 'connecting' | 'connected' | 'closed' | 'error' = 'idle';

  addSink(sink: FrameSink) {
    this.sinks.add(sink);
    this.ensureConnection();
  }

  removeSink(sink: FrameSink) {
    this.sinks.delete(sink);
  }

  send(buf: ArrayBuffer | Buffer): boolean {
    this.ensureConnection();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      return true;
    }
    return false;
  }

  // Awaitable variant: gives the upstream WS up to `timeoutMs` to come up
  // before failing. Used by /api/shock so the FIRST shock after a fresh
  // page load doesn't get rejected just because the bridge is still
  // doing its handshake.
  async sendWhenReady(buf: ArrayBuffer | Buffer, timeoutMs = 2000): Promise<boolean> {
    this.ensureConnection();
    const deadline = Date.now() + timeoutMs;
    while (
      (!this.ws || this.ws.readyState !== WebSocket.OPEN) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      return true;
    }
    return false;
  }

  isAlive(): boolean {
    return (
      this.ws?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastMsgAt < 5000
    );
  }

  private ensureConnection() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    if (this.connecting) return;
    this.connecting = true;
    this.status = 'connecting';

    const ws = new WebSocket(BACKEND_WS_URL, { perMessageDeflate: false });
    this.ws = ws;

    ws.on('open', () => {
      this.connecting = false;
      this.status = 'connected';
      this.backoffMs = 500;
      this.lastMsgAt = Date.now();
      console.log('[bridge] upstream connected to', BACKEND_WS_URL);
    });

    ws.on('message', (data, isBinary) => {
      // uWS sends binary frames; `data` is a Buffer.
      const buf = isBinary
        ? (data as Buffer)
        : Buffer.from(data as Buffer);
      this.lastMsgAt = Date.now();
      for (const sink of this.sinks) {
        try {
          sink(buf);
        } catch (err) {
          console.error('[bridge] sink threw', err);
        }
      }
    });

    ws.on('close', () => {
      this.status = 'closed';
      this.connecting = false;
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.status = 'error';
      console.error('[bridge] upstream error', err.message);
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    if (this.sinks.size === 0) return; // No subscribers — let it stay closed.
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnection();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, 5000);
  }
}

// Hot-reload-safe singleton — Next.js dev server reloads this module on
// every code change, but globalThis survives.
const G = globalThis as unknown as { __optiriskBridge?: UpstreamBridge };
export const upstream: UpstreamBridge =
  G.__optiriskBridge ?? (G.__optiriskBridge = new UpstreamBridge());

// Eagerly open the upstream WS so the very first browser request finds
// the bridge already connected. Keep one always-on sentinel sink; this
// also keeps the watchdog/reconnect loop alive even when no SSE clients
// are subscribed.
const SENTINEL: (b: Buffer) => void = () => {};
upstream.addSink(SENTINEL);
