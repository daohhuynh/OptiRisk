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

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:8080';
const MAX_BACKOFF_MS = 8000;

class WebSocketService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = 1000;
  private running = false;

  start() {
    this.running = true;
    this.connect();
  }

  stop() {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
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
    return false;
  }

  // Cascade-branch parity: best-effort flush of any in-flight messages so the
  // RESET button returns a perfectly clean slate. The current binary
  // protocol is one-shot per send so there's nothing buffered locally; the
  // method exists for API compatibility.
  clearPendingTicks(): void {
    /* no-op — kept for symmetry with cascade branch */
  }

  // Fire-and-forget RESET: tells the backend to reload baseline state and
  // also clears local frontend visuals immediately. Uses a magic shock_type
  // of 0xFF that the backend's compute thread interprets as "reset".
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

  private connect() {
    const conn = useConnectionStore.getState();
    conn.setStatus('connecting');

    try {
      this.ws = new WebSocket(WS_URL);
      this.ws.binaryType = 'arraybuffer';
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      conn.setStatus('connected');
      this.backoffMs = 1000;
      useSimulationStore.getState().addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'connected',
        timestamp: Date.now(),
        label: `> LINK_ESTABLISHED ${WS_URL}`,
      });
    };

    this.ws.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
      const t0 = performance.now();
      this.handleMessage(evt.data);
      const latencyUs = (performance.now() - t0) * 1000;
      conn.setLatency(Math.round(latencyUs));
      conn.recordMessage();
    };

    this.ws.onerror = () => {
      conn.setStatus('error');
    };

    this.ws.onclose = () => {
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
        graph.applyTickDelta(msg);
        sim.setTick(msg.tickSeq);
        if (msg.isDefaulted) {
          sim.incrementDefaults();
          sim.addEvent({
            id: Math.random().toString(36).slice(2),
            type: 'node_default',
            timestamp: Date.now(),
            label: `> DEFAULT NODE_${msg.nodeId} CASCADE_DEPTH=${msg.cascadeDepth}`,
            nodeId: msg.nodeId,
            cascadeDepth: msg.cascadeDepth,
          });
        }
        if (msg.cascadeDepth > 0 && sim.phase === 'shock_triggered') {
          sim.setPhase('cascade_running');
        }
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
}

export const wsService = new WebSocketService();
