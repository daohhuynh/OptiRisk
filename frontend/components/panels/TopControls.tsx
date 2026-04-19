'use client';

import { useCallback } from 'react';
import { useConnectionStore } from '@/store/connectionStore';
import { useGraphStore } from '@/store/graphStore';
import { useSimulationStore } from '@/store/simulationStore';
import { SHOCK_PRESETS } from '@/types/simulation';
import type { ShockType } from '@/types/simulation';
import { encodeShockPayload } from '@/lib/binary/encodeShock';
import { wsService } from '@/services/websocket';
import { parseInitialSnapshot } from '@/lib/graph/indexing';

const SHOCK_BUTTONS: { label: string; type: Exclude<ShockType, 'custom'>; danger: boolean }[] = [
  { label: 'LEHMAN 2008', type: 'lehman2008', danger: true },
  { label: 'COVID 2020', type: 'covid2020', danger: true },
  { label: 'RATE HIKE', type: 'rate_hike', danger: false },
  { label: 'CRYPTO CRASH', type: 'crypto_crash', danger: false },
];

export default function TopControls() {
  const status = useConnectionStore(s => s.status);
  const isConnected = useConnectionStore(s => s.isConnected);
  const setLatency = useConnectionStore(s => s.setLatency);
  const lastLatencyUs = useConnectionStore(s => s.lastLatencyUs);
  const totalNodes = useGraphStore(s => s.totalNodes);
  const loadSnapshot = useGraphStore(s => s.loadSnapshot);
  const totalDefaults = useSimulationStore(s => s.totalDefaults);
  const currentTick = useSimulationStore(s => s.currentTick);
  const phase = useSimulationStore(s => s.phase);
  const activeShockConfig = useSimulationStore(s => s.activeShockConfig);
  const recordShockSent = useSimulationStore(s => s.recordShockSent);
  const reset = useSimulationStore(s => s.reset);

  const fireShock = useCallback((type: Exclude<ShockType, 'custom'>) => {
    const preset = SHOCK_PRESETS[type];
    const config = { targetNodeId: 0xFFFFFFFF, shockType: type, ...preset };
    if (!wsService.sendBinary(encodeShockPayload(config))) return;
    recordShockSent(config);
  }, [recordShockSent]);

  // [FIXED] Merged the binary broadcast and state reset into one clean hook
  const handleReset = useCallback(() => {
    wsService.clearPendingTicks();
    // 1. Blast the 0xFF Magic Number to C++ Engine
    const buffer = new ArrayBuffer(60);
    const view = new DataView(buffer);
    view.setUint8(0, 0x01); // MsgType.ShockPayload
    view.setUint16(2, 56, true);
    view.setUint32(4, 0xFFFFFFFF, true); // Target: ALL
    view.setUint32(8, 0xFF, true);       // MAGIC SHOCK_TYPE: 0xFF = Reset
    wsService.sendBinary(buffer);

    // 2. Clear Frontend State
    reset();
    setLatency(0);
    fetch('/optirisk_initial_state.json')
      .then((r) => r.json())
      .then((json) => {
        const { nodes, edges } = parseInitialSnapshot(json);
        loadSnapshot(nodes, edges);
      })
      .catch(console.error);
  }, [loadSnapshot, reset, setLatency]);

  const isCascading = phase === 'cascade_running' || phase === 'shock_triggered';

  return (
    <div
      className="w-full flex items-center justify-between px-4 h-14"
      style={{
        background: 'rgba(4,8,16,0.95)',
        borderBottom: '1px solid rgba(0,200,255,0.15)',
        backdropFilter: 'blur(12px)',
      }}
    >
      {/* Brand */}
      <div className="flex items-center gap-3 min-w-[200px]">
        <div className="flex items-center gap-2">
          <div className={`status-dot ${isConnected ? 'connected' : status === 'error' ? 'error' : ''}`} />
          <span
            className="text-sm font-semibold text-[#c8e6f5]"
            style={{ fontFamily: 'Chakra Petch, sans-serif', letterSpacing: '0.2em' }}
          >
            OPTIRISK
          </span>
          <span className="text-xs text-[#4a7a9b] font-mono">v0.1.0</span>
        </div>
        <div className="h-4 w-px bg-[rgba(0,200,255,0.2)]" />
        <span className="text-xs font-mono text-[#4a7a9b]">{lastLatencyUs}μs</span>
      </div>

      {/* Shock buttons */}
      <div className="flex items-center gap-2">
        <span
          className="text-xs text-[#4a7a9b] mr-2 tracking-widest"
          style={{ fontFamily: 'Chakra Petch, sans-serif' }}
        >
          INJECT SHOCK
        </span>
        {SHOCK_BUTTONS.map(({ label, type, danger }) => {
          const isActive = activeShockConfig?.shockType === type;
          return (
            <button
              key={type}
              onClick={() => fireShock(type)}
              disabled={false}
              className={[
                'px-3 py-1 text-xs font-semibold tracking-wider transition-all duration-150',
                'border disabled:opacity-30 disabled:cursor-not-allowed',
                isActive
                  ? danger
                    ? 'bg-[#ff2020] border-[#ff2020] text-white'
                    : 'bg-[#ff8c00] border-[#ff8c00] text-white'
                  : danger
                    ? 'bg-transparent border-[rgba(255,32,32,0.4)] text-[#ff6060] hover:bg-[rgba(255,32,32,0.15)] hover:border-[#ff2020]'
                    : 'bg-transparent border-[rgba(0,200,255,0.25)] text-[#00e5ff] hover:bg-[rgba(0,229,255,0.1)] hover:border-[#00e5ff]',
              ].join(' ')}
              style={{ fontFamily: 'Chakra Petch, sans-serif', borderRadius: '2px' }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {/* Stats + reset */}
      <div className="flex items-center gap-4 min-w-[200px] justify-end">
        <div className="flex items-center gap-3 text-xs font-mono text-[#4a7a9b]">
          <span><span className="text-[#c8e6f5]">{totalNodes}</span> NODES</span>
          <span><span className="text-[#ff2020]">{totalDefaults}</span> DEFAULTS</span>
          <span>
            TICK{' '}
            <span className={`text-[#00e5ff] ${isCascading ? 'animate-blink' : ''}`}>
              {String(currentTick).padStart(6, '0')}
            </span>
          </span>
        </div>
        {/* [FIXED] Proper JSX Button */}
        {activeShockConfig && (
          <button
            onClick={handleReset}
            className="px-3 py-1 text-xs font-semibold tracking-wider text-[#ff2020] border border-[rgba(255,32,32,0.4)] hover:bg-[rgba(255,32,32,0.15)] hover:border-[#ff2020] transition-colors"
            style={{ fontFamily: 'Chakra Petch, sans-serif', borderRadius: '2px' }}
          >
            RESET SIMULATION
          </button>
        )}
      </div>
    </div>
  );
}
