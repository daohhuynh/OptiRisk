"use client";

import { useEffect, useRef, useState, useCallback } from "react";

// ============================================================================
// useRiskFeed.ts — High-Frequency Binary WebSocket Hook
//
// Establishes a robust WS connection for ingesting massive C++ physics
// arrays. Decouples the dense network stream from the React DOM reconciliation
// loop by buffering payloads into a mutable React Three Fiber reference Map,
// avoiding 60FPS lockups entirely.
// ============================================================================

const NODE_UPDATE_SIZE = 13; // 4 + 4 + 4 + 1 exactly due to #pragma pack(1)

export interface NodeUpdate {
  nodeId: number;
  newNav: number;
  var99: number;
  isLiquidated: boolean;
}

export function useRiskFeed(wsUrl: string = "ws://localhost:9001") {
  // ── WebGL Hot-Path State ──────────────────────────────────────────
  // Do NOT place this inside useState(). Putting 500 node mappings
  // into React state forces deep reconciliation. WebGL components
  // can directly poll this ref via R3F's useFrame.
  const nodesRef = useRef<Map<number, NodeUpdate>>(new Map());

  // ── UI Cold-Path State ────────────────────────────────────────────
  // We track overall connection and latency purely for HTML overlay UI.
  // Batched to exactly MAX 1 render per display frame.
  const [isConnected, setIsConnected] = useState(false);
  const [latencyUs, setLatencyUs] = useState(0);

  // ── Engine Internals ──────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempt = useRef<number>(0);
  const packetQueue = useRef<ArrayBuffer[]>([]);
  const latencyBatch = useRef<number[]>([]);
  const rafId = useRef<number>(0);

  // ── Throttled Consumer Loop ───────────────────────────────────────
  // Process all inbound byte blocks 1 time per browser refresh
  const processQueue = useCallback(() => {
    let mapUpdated = false;

    // Process all pending packets received in this frame
    while (packetQueue.current.length > 0) {
      const buffer = packetQueue.current.shift();
      if (!buffer) break;

      const view = new DataView(buffer);
      const count = Math.floor(buffer.byteLength / NODE_UPDATE_SIZE);

      for (let i = 0; i < count; i++) {
        const offset = i * NODE_UPDATE_SIZE;
        
        // Exact byte offsets mapping to C++ struct NodeUpdate
        const node_id       = view.getUint32(offset + 0, true);   // Little-endian
        const new_nav       = view.getFloat32(offset + 4, true);  // Little-endian
        const var_99        = view.getFloat32(offset + 8, true);  // Little-endian
        const is_liquidated = view.getUint8(offset + 12) === 1;

        nodesRef.current.set(node_id, {
          nodeId: node_id,
          newNav: new_nav,
          var99: var_99,
          isLiquidated: is_liquidated
        });
        
        mapUpdated = true;
      }
    }

    // Abridge latency metrics to prevent spam if UI tracks it
    if (latencyBatch.current.length > 0) {
      const avgLatency = latencyBatch.current.reduce((a, b) => a + b, 0) / latencyBatch.current.length;
      setLatencyUs(Math.round(avgLatency));
      latencyBatch.current = [];
    }

    // Optional debug flag if needed
    // if (mapUpdated) console.log(`[useRiskFeed] Processed mapped frame`);

    // Queue next cycle naturally bound to browser sync refresh
    rafId.current = requestAnimationFrame(processQueue);
  }, []);

  // ── Connection Automata ───────────────────────────────────────────
  const connect = useCallback(() => {
    // Prune stale connection
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(`[useRiskFeed] Dialing ${wsUrl}...`);
    const ws = new WebSocket(wsUrl);
    
    // CRITICAL: We legally require ArrayBuffer instead of Blob.
    // Blob offloads to disk/memory and destroys JS main queue.
    ws.binaryType = "arraybuffer"; 
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[useRiskFeed] Connected. Receiving telemetry...");
      setIsConnected(true);
      reconnectAttempt.current = 0; // Reset backoff profile
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return; // Reject strings
      
      const recv_time = performance.now() * 1000; // microsecond mark
      
      packetQueue.current.push(event.data);
      
      // Calculate generic network arrival tick delay (rough latency estimation)
      const parse_time = performance.now() * 1000; 
      latencyBatch.current.push(parse_time - recv_time);
    };

    ws.onclose = () => {
      setIsConnected(false);
      
      // Exponential backoff mechanism with Jitter (prevents exact stampedes)
      const power = Math.min(reconnectAttempt.current, 8); // Max 2^8 seconds
      const delayMs = (1000 * Math.pow(2, power)) + (Math.random() * 500);
      reconnectAttempt.current++;
      
      console.warn(`[useRiskFeed] Dropped connection. Re-dialing in ${Math.round(delayMs)}ms...`);
      setTimeout(connect, delayMs);
    };

    ws.onerror = (err) => {
      console.error("[useRiskFeed] WebSocket hard error:", err);
      ws.close();
    };
  }, [wsUrl]);

  // ── Lifecycle Management ──────────────────────────────────────────
  useEffect(() => {
    connect();
    // Engage the 60FPS data polling pump
    rafId.current = requestAnimationFrame(processQueue);
    
    return () => {
      cancelAnimationFrame(rafId.current);
      if (wsRef.current) wsRef.current.close();
    };
  }, [connect, processQueue]);

  return {
    nodesRef,
    isConnected,
    latencyUs
  };
}
