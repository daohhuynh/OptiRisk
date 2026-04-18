"use client";

import { Activity, Radio, Shield } from "lucide-react";
import RiskMap from "@/components/RiskMap";
import { useRiskSocket } from "@/hooks/useRiskSocket";

export default function Home() {
  const { isConnected, nodeCount, lastLatency } = useRiskSocket();

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-surface-900">
      {/* ── 3D Canvas ──────────────────────────────────────────── */}
      <div className="canvas-container">
        <RiskMap />
      </div>

      {/* ── HUD Overlay ────────────────────────────────────────── */}
      <div className="hud-overlay">
        {/* Top Bar */}
        <header className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <Shield className="w-6 h-6 text-indigo-400" />
            <h1 className="text-lg font-semibold tracking-tight font-mono">
              OPTIRISK
            </h1>
            <span className="text-xs text-slate-500 font-mono ml-2">
              v0.1.0
            </span>
          </div>

          <div className="flex items-center gap-6 text-sm font-mono">
            {/* Connection Status */}
            <div className="flex items-center gap-2">
              <span
                className={`status-dot ${
                  isConnected ? "connected" : "disconnected"
                }`}
              />
              <span className="text-slate-400">
                {isConnected ? "LIVE" : "OFFLINE"}
              </span>
            </div>

            {/* Node Count */}
            <div className="flex items-center gap-2 text-slate-400">
              <Radio className="w-4 h-4" />
              <span>{nodeCount} nodes</span>
            </div>

            {/* Latency */}
            <div className="flex items-center gap-2 text-slate-400">
              <Activity className="w-4 h-4" />
              <span>{lastLatency} μs</span>
            </div>
          </div>
        </header>

        {/* Bottom Info Bar */}
        <div className="absolute bottom-4 left-6 right-6 flex items-center justify-between">
          <p className="text-xs text-slate-600 font-mono">
            Binary WebSocket · CSR Graph Engine · LMAX Disruptor Pipeline
          </p>
          <p className="text-xs text-slate-600 font-mono">
            C++23 Zero-Allocation Backend
          </p>
        </div>
      </div>
    </main>
  );
}
