"use client";

import { useEffect, useRef, useCallback } from "react";
import { create } from "zustand";

// ── Binary Wire Format (matches backend NodeSnapshot) ──────────────
// Offset 0:  uint32  node_id
// Offset 4:  float32 risk_score
// Offset 8:  float32 exposure
// Offset 12: uint8   is_defaulted
// Offset 13: uint8[3] padding
// Total: 16 bytes per node
const NODE_SNAPSHOT_SIZE = 16;

export interface NodeSnapshot {
  nodeId: number;
  riskScore: number;
  exposure: number;
  isDefaulted: boolean;
}

// ── Zustand Store ──────────────────────────────────────────────────
interface RiskStore {
  isConnected: boolean;
  nodeCount: number;
  lastLatency: number;
  nodes: Map<number, NodeSnapshot>;
  setConnected: (connected: boolean) => void;
  updateNode: (snapshot: NodeSnapshot) => void;
  setLatency: (us: number) => void;
}

export const useRiskStore = create<RiskStore>((set, get) => ({
  isConnected: false,
  nodeCount: 0,
  lastLatency: 0,
  nodes: new Map(),
  setConnected: (connected) => set({ isConnected: connected }),
  updateNode: (snapshot) => {
    const nodes = new Map(get().nodes);
    nodes.set(snapshot.nodeId, snapshot);
    set({ nodes, nodeCount: nodes.size });
  },
  setLatency: (us) => set({ lastLatency: us }),
}));

// ── Binary Parser ──────────────────────────────────────────────────
function parseBinaryFrame(buffer: ArrayBuffer): NodeSnapshot[] {
  const view = new DataView(buffer);
  const count = Math.floor(buffer.byteLength / NODE_SNAPSHOT_SIZE);
  const snapshots: NodeSnapshot[] = [];

  for (let i = 0; i < count; i++) {
    const offset = i * NODE_SNAPSHOT_SIZE;
    snapshots.push({
      nodeId:      view.getUint32(offset, true),      // Little-endian
      riskScore:   view.getFloat32(offset + 4, true),
      exposure:    view.getFloat32(offset + 8, true),
      isDefaulted: view.getUint8(offset + 12) === 1,
    });
  }

  return snapshots;
}

// ── WebSocket Hook ─────────────────────────────────────────────────
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:9001";
const RECONNECT_DELAY_MS = 2000;

export function useRiskSocket() {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const store = useRiskStore();

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";  // Critical: receive raw binary, NOT blob
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[OptiRisk] WebSocket connected");
      useRiskStore.getState().setConnected(true);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;  // Ignore non-binary

      const t0 = performance.now();
      const snapshots = parseBinaryFrame(event.data);
      const t1 = performance.now();

      const { updateNode, setLatency } = useRiskStore.getState();
      for (const snap of snapshots) {
        updateNode(snap);
      }
      setLatency(Math.round((t1 - t0) * 1000));  // Convert ms → μs
    };

    ws.onclose = () => {
      console.log("[OptiRisk] WebSocket disconnected, reconnecting...");
      useRiskStore.getState().setConnected(false);
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = (err) => {
      console.error("[OptiRisk] WebSocket error:", err);
      ws.close();
    };
  }, []);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return {
    isConnected: store.isConnected,
    nodeCount: store.nodeCount,
    lastLatency: store.lastLatency,
    nodes: store.nodes,
  };
}
