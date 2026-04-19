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

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080';
const MAX_BACKOFF_MS = 8000;

// Non-reactive data sink: decouples binary ingestion from React state updates
const tickSink = new Map<number, TickDeltaMsg>();
let rafId: number | null = null;

class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private completeTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTicks = new Map<number, TickDeltaMsg>();
  private backoffMs = 1000;
  private running = false;

  start() {
    if (this.running && this.ws && this.ws.readyState <= WebSocket.OPEN) return;
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.completeTimer) clearTimeout(this.completeTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.pendingTicks.clear();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    useConnectionStore.getState().setStatus('disconnected');
  }

  sendBinary(buf: ArrayBuffer): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buf);
      return true;
    }
    // DO NOT flip status to 'error' here — a missed send is a UI no-op,
    // not a transport failure. The real error will be reported by the
    // browser via ws.onerror, which already calls setStatus('error').
    return false;
  }

  // Fire-and-forget RESET: tells the backend to reload baseline state.
  // Backend's compute thread interprets shock_type=0xFF as "reset".
  sendReset(): boolean {
    const buf = new ArrayBuffer(60);
    const v = new DataView(buf);
    v.setUint8(0, 0x01);                  // MsgType.ShockPayload
    v.setUint8(1, 0);
    v.setUint16(2, 56, true);             // payload_len
    v.setUint32(4, 0xFFFFFFFF, true);     // target_node = ALL
    v.setUint32(8, 0xFF, true);           // shock_type = MAGIC RESET
    v.setBigUint64(52, BigInt(Date.now()) * 1_000_000n, true);
    return this.sendBinary(buf);
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

  private connect() {
    const conn = useConnectionStore.getState();
    conn.setStatus('connecting');

    try {
      const ws = new WebSocket(WS_URL);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
    } catch {
      this.scheduleReconnect();
      return;
    }

    const ws = this.ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      useConnectionStore.getState().setStatus('connected');
      useConnectionStore.getState().setLatency(0);
      this.backoffMs = 1000;
      useSimulationStore.getState().addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'connected',
        timestamp: Date.now(),
        label: `> LINK_ESTABLISHED ${WS_URL}`,
      });
    };

    ws.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
      if (this.ws !== ws) return;
      this.handleMessage(evt.data);
      conn.recordMessage();
    };

    ws.onerror = () => {
      if (this.ws !== ws) return;
      conn.setStatus('error');
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!this.running) return;
      conn.setStatus('disconnected');
      useSimulationStore.getState().addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'disconnected',
        timestamp: Date.now(),
        label: `> LINK_LOST — reconnecting in ${this.backoffMs}ms`,
      });
      this.scheduleReconnect();
    };
  }

  private handleMessage(buf: ArrayBuffer) {
    const msgType = parseMessageType(buf);
    const graph = useGraphStore.getState();
    const sim = useSimulationStore.getState();

    switch (msgType) {
      case MsgType.TickDelta: {
        const msg = decodeTickDelta(buf);
        if (!msg) return;
        // Write to non-reactive sink instead of triggering React state update
        tickSink.set(msg.nodeId, msg);
        // Schedule rAF if not already scheduled
        if (!rafId) {
          rafId = requestAnimationFrame(flushSink);
        }
        // Preserve existing 16ms setTimeout batching as fallback for low-frequency updates
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
        // intentional no-op — keeps connection alive, latency already recorded
        break;
      default:
        break;
    }
  }

  private scheduleReconnect() {
    if (!this.running) return;
    this.reconnectTimer = setTimeout(() => {
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

// flushSink: pulls from non-reactive sink at 60fps and updates React state
function flushSink() {
  if (tickSink.size === 0) {
    rafId = null;
    return;
  }

  // Read all entries from sink
  const ticks = Array.from(tickSink.values());
  tickSink.clear();

  // Update React state with batched deltas
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

  // Reset rafId to allow next frame to be scheduled
  rafId = null;
}

export const wsService = new WebSocketService();
