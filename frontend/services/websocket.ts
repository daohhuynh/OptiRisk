// ============================================================================
// websocket.ts — Browser-side transport, now SSE + POST instead of raw WS.
//
// We keep the public class name `WebSocketService` and method names so the
// rest of the app (TopControls, ChatPanel, hooks, etc.) is untouched.
//
// Wire layout:
//   incoming binary frames  ←  EventSource('/api/stream')  ←  Next.js  ←  C++
//   outgoing shock frames   →  POST /api/shock             →  Next.js  →  C++
//
// Why this works when raw ws://localhost:8080 didn't:
//   * The browser only ever opens a connection to its own origin (the
//     port it loaded the HTML from). No second port to expose. No CORS,
//     no mixed content, no WSL2 / VPN / corp-proxy port-forwarding pain.
//   * SSE is plain HTTP/1.1; every dev server, router, and tunnel passes
//     it through unchanged.
//   * The Next.js Node runtime opens ONE persistent ws:// to the C++
//     backend and fans frames out to all SSE listeners (see
//     /lib/bridge/upstream.ts).
// ============================================================================

import {
  parseMessageType,
  decodeTickDelta,
  decodeVaRReport,
  decodeMarketAnchors,
} from '@/lib/binary/decodeDelta';
import { MsgType } from '@/lib/binary/schema';
import { useConnectionStore } from '@/store/connectionStore';
import { useGraphStore } from '@/store/graphStore';
import { useSimulationStore } from '@/store/simulationStore';
import type { TickDeltaMsg } from '@/types/simulation';

const STREAM_URL = '/api/stream';
const SHOCK_URL = '/api/shock';
const MAX_BACKOFF_MS = 8000;

// Non-reactive data sink: decouples binary ingestion from React state updates.
const tickSink = new Map<number, TickDeltaMsg>();
let rafId: number | null = null;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; ++i) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

class WebSocketService {
  private es: EventSource | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private completeTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTicks = new Map<number, TickDeltaMsg>();
  private backoffMs = 1000;
  private running = false;
  private watchdogId: ReturnType<typeof setInterval> | null = null;
  // Ref-count of active subscribers (page.tsx, MapContainer, etc).
  // React 18 StrictMode mounts effects twice in dev; without this,
  // the second cleanup tears down the live SSE connection.
  private refCount = 0;

  start() {
    this.refCount++;
    if (this.running && this.es && this.es.readyState !== EventSource.CLOSED) return;
    this.running = true;
    this.connect();
  }

  stop() {
    if (this.refCount > 0) this.refCount--;
    if (this.refCount > 0) return; // Other consumers still need it.
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.completeTimer) clearTimeout(this.completeTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.stopWatchdog();
    this.pendingTicks.clear();
    if (this.es) {
      this.es.close();
      this.es = null;
    }
    useConnectionStore.getState().setStatus('disconnected');
  }

  // ── Outbound ──────────────────────────────────────────────────────────
  // Legacy callers (chat panel etc.) still invoke `sendBinary(ArrayBuffer)`.
  // We forward that frame through the integration bridge unchanged.
  sendBinary(buf: ArrayBuffer): boolean {
    const b64 =
      typeof window !== 'undefined'
        ? btoa(String.fromCharCode(...new Uint8Array(buf)))
        : Buffer.from(buf).toString('base64');
    void this.postShock({ base64: b64 });
    return true;
  }

  sendReset(): boolean {
    void this.postShock({ reset: true });
    return true;
  }

  private async postShock(body: object): Promise<boolean> {
    try {
      const r = await fetch(SHOCK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        console.warn('[ws] /api/shock returned', r.status);
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[ws] /api/shock failed', err);
      return false;
    }
  }

  clearPendingTicks() {
    this.pendingTicks.clear();
    tickSink.clear();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.completeTimer) {
      clearTimeout(this.completeTimer);
      this.completeTimer = null;
    }
  }

  // ── Inbound (SSE) ─────────────────────────────────────────────────────
  private connect() {
    const conn = useConnectionStore.getState();
    conn.setStatus('connecting');

    let es: EventSource;
    try {
      es = new EventSource(STREAM_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.es = es;

    es.onopen = () => {
      if (this.es !== es) return;
      // SSE is open to /api/stream; wait for first real frame to mark
      // the upstream backend healthy. Watchdog handles the timing.
      // Seed lastMessageTime to NOW so the watchdog doesn't immediately
      // think we've been silent forever and force-close the connection.
      const c = useConnectionStore.getState();
      c.setStatus('connecting');
      c.recordMessage();
      this.backoffMs = 1000;
      this.startWatchdog();
      useSimulationStore.getState().addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'connected',
        timestamp: Date.now(),
        label: `> LINK_ESTABLISHED ${STREAM_URL} (waiting for heartbeat)`,
      });
    };

    es.onmessage = (evt: MessageEvent<string>) => {
      if (this.es !== es) return;
      const c = useConnectionStore.getState();
      if (c.status !== 'connected') c.setStatus('connected');
      const buf = base64ToArrayBuffer(evt.data);
      this.handleMessage(buf);
      c.recordMessage();
    };

    es.onerror = () => {
      if (this.es !== es) return;
      // EventSource auto-reconnects, but we still flag status.
      const c = useConnectionStore.getState();
      if (c.status === 'connected') c.setStatus('connecting');
      // If the stream actually CLOSED (vs. transient blip) restart manually.
      if (es.readyState === EventSource.CLOSED) {
        es.close();
        this.es = null;
        this.stopWatchdog();
        if (!this.running) return;
        useSimulationStore.getState().addEvent({
          id: Math.random().toString(36).slice(2),
          type: 'disconnected',
          timestamp: Date.now(),
          label: `> LINK_LOST — reconnecting in ${this.backoffMs}ms`,
        });
        this.scheduleReconnect();
      }
    };
  }

  // ── Bidirectional liveness watchdog ──────────────────────────────────
  // Backend pushes a Heartbeat every 1s. If we haven't heard from it in
  // >3s while we believe we're connected, downgrade to 'connecting'. If
  // silent for >8s, force-close the SSE so the reconnect loop tries fresh.
  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogId = setInterval(() => {
      const c = useConnectionStore.getState();
      // If we haven't recorded a single message yet, don't trip the
      // silence alarm — we're still in the initial warm-up window.
      if (c.lastMessageTime == null) return;
      const silentMs = Date.now() - c.lastMessageTime;
      if (!this.es || this.es.readyState !== EventSource.OPEN) return;
      if (silentMs > 8000) {
        try { this.es.close(); } catch { /* noop */ }
        this.es = null;
        this.stopWatchdog();
        this.scheduleReconnect();
        return;
      }
      if (silentMs > 3000 && c.status === 'connected') {
        c.setStatus('connecting');
      }
    }, 1000);
  }
  private stopWatchdog() {
    if (this.watchdogId) {
      clearInterval(this.watchdogId);
      this.watchdogId = null;
    }
  }

  private handleMessage(buf: ArrayBuffer) {
    const msgType = parseMessageType(buf);
    const sim = useSimulationStore.getState();

    switch (msgType) {
      case MsgType.TickDelta: {
        const msg = decodeTickDelta(buf);
        if (!msg) return;
        tickSink.set(msg.nodeId, msg);
        if (!rafId) {
          rafId = requestAnimationFrame(flushSink);
        }
        this.scheduleTickFlush();
        break;
      }
      case MsgType.VaRReport: {
        const msg = decodeVaRReport(buf);
        if (msg) sim.applyVaRReport(msg);
        break;
      }
      case MsgType.MarketAnchors: {
        const msg = decodeMarketAnchors(buf);
        if (msg) sim.setMarketAnchors(msg);
        break;
      }
      case MsgType.Heartbeat:
        // Heartbeat — proves liveness, nothing else to do.
        break;
      default:
        break;
    }
  }

  private scheduleReconnect() {
    if (!this.running) return;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    useConnectionStore.getState().incrementReconnect();
  }

  private scheduleTickFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushTickDeltas();
    }, 16);
  }

  private flushTickDeltas() {
    if (this.pendingTicks.size === 0) return;

    const ticks = Array.from(this.pendingTicks.values());
    this.pendingTicks.clear();

    const graph = useGraphStore.getState();
    const sim = useSimulationStore.getState();
    let newDefaults = 0;
    let maxTick = sim.currentTick;
    let maxCascadeDepth = 0;
    let firstDefault: TickDeltaMsg | null = null;

    for (const msg of ticks) {
      if (msg.tickSeq > maxTick) maxTick = msg.tickSeq;
      if (msg.cascadeDepth > maxCascadeDepth) maxCascadeDepth = msg.cascadeDepth;
      if (msg.isDefaulted && !graph.defaultedNodeIds.has(msg.nodeId)) {
        ++newDefaults;
        if (!firstDefault) firstDefault = msg;
      }
    }

    graph.applyTickDeltas(ticks);
    sim.setTick(maxTick);

    if (newDefaults > 0) {
      sim.incrementDefaultsBy(newDefaults);
      if (firstDefault) {
        sim.addEvent({
          id: Math.random().toString(36).slice(2),
          type: 'node_default',
          timestamp: Date.now(),
          label: `> DEFAULTS +${newDefaults} FIRST_NODE_${firstDefault.nodeId}`,
          nodeId: firstDefault.nodeId,
          cascadeDepth: firstDefault.cascadeDepth,
        });
      }
    }

    if (this.completeTimer) clearTimeout(this.completeTimer);
    this.completeTimer = setTimeout(() => {
      const phase = useSimulationStore.getState().phase;
      if (phase === 'shock_triggered' || phase === 'cascade_running') {
        useSimulationStore.getState().setPhase('cascade_complete');
      }
    }, 500);

    const phase = useSimulationStore.getState().phase;
    if (maxCascadeDepth > 0 && phase === 'shock_triggered') {
      useSimulationStore.getState().setPhase('cascade_running');
    } else if (phase === 'pre_shock') {
      useSimulationStore.getState().setPhase('shock_triggered');
    }
  }
}

// flushSink: pulls from non-reactive sink at 60fps and updates React state.
function flushSink() {
  if (tickSink.size === 0) {
    rafId = null;
    return;
  }

  const ticks = Array.from(tickSink.values());
  tickSink.clear();

  const graph = useGraphStore.getState();
  const sim = useSimulationStore.getState();
  let newDefaults = 0;
  let maxTick = sim.currentTick;
  let maxCascadeDepth = 0;
  let firstDefault: TickDeltaMsg | null = null;

  for (const msg of ticks) {
    if (msg.tickSeq > maxTick) maxTick = msg.tickSeq;
    if (msg.cascadeDepth > maxCascadeDepth) maxCascadeDepth = msg.cascadeDepth;
    if (msg.isDefaulted && !graph.defaultedNodeIds.has(msg.nodeId)) {
      ++newDefaults;
      if (!firstDefault) firstDefault = msg;
    }
  }

  graph.applyTickDeltas(ticks);
  sim.setTick(maxTick);

  if (newDefaults > 0) {
    sim.incrementDefaultsBy(newDefaults);
    if (firstDefault) {
      sim.addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'node_default',
        timestamp: Date.now(),
        label: `> DEFAULTS +${newDefaults} FIRST_NODE_${firstDefault.nodeId}`,
        nodeId: firstDefault.nodeId,
        cascadeDepth: firstDefault.cascadeDepth,
      });
    }
  }

  const phase = useSimulationStore.getState().phase;
  if (maxCascadeDepth > 0 && phase === 'shock_triggered') {
    useSimulationStore.getState().setPhase('cascade_running');
  } else if (phase === 'pre_shock') {
    useSimulationStore.getState().setPhase('shock_triggered');
  }

  rafId = null;
}

export const wsService = new WebSocketService();
