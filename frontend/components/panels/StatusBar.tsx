'use client';

import { useConnectionStore } from '@/store/connectionStore';
import { useGraphStore } from '@/store/graphStore';
import { useSimulationStore } from '@/store/simulationStore';

const PHASE_LABELS: Record<string, { label: string; color: string }> = {
  pre_shock:        { label: 'PRE-SHOCK',        color: '#4a7a9b' },
  shock_triggered:  { label: 'SHOCK TRIGGERED',  color: '#ff8c00' },
  cascade_running:  { label: 'CASCADE ACTIVE',   color: '#ff2020' },
  cascade_complete: { label: 'CASCADE COMPLETE', color: '#00e5ff' },
  paused:           { label: 'PAUSED',           color: '#4a7a9b' },
};

export default function StatusBar() {
  // Granular selectors
  const status        = useConnectionStore(s => s.status);
  const lastLatencyUs = useConnectionStore(s => s.lastLatencyUs);
  const reconnectCount = useConnectionStore(s => s.reconnectCount);
  const totalNodes    = useGraphStore(s => s.totalNodes);
  const totalEdges    = useGraphStore(s => s.totalEdges);
  const phase         = useSimulationStore(s => s.phase);
  const currentTick   = useSimulationStore(s => s.currentTick);
  const totalDefaults = useSimulationStore(s => s.totalDefaults);

  const phaseInfo = PHASE_LABELS[phase] ?? PHASE_LABELS.pre_shock;

  return (
    <div
      className="w-full h-8 flex items-center justify-between px-4"
      style={{
        background: 'rgba(4,8,16,0.95)',
        borderTop: '1px solid rgba(0,200,255,0.1)',
        fontFamily: 'JetBrains Mono, monospace',
      }}
    >
      <div className="flex items-center gap-4 text-[10px] text-[#4a7a9b]">
        <span>BINARY WEBSOCKET</span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <span>CSR GRAPH ENGINE</span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <span>LMAX DISRUPTOR</span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <span>C++23 ZERO-ALLOC</span>
      </div>

      <div className="flex items-center gap-3 text-[10px]">
        <span
          className="font-semibold tracking-widest"
          style={{ color: phaseInfo.color, fontFamily: 'Chakra Petch, sans-serif' }}
        >
          {phaseInfo.label}
        </span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <span className="text-[#4a7a9b]">
          TICK: <span className="text-[#c8e6f5]">{String(currentTick).padStart(6, '0')}</span>
        </span>
        {totalDefaults > 0 && (
          <>
            <span className="text-[rgba(0,200,255,0.3)]">·</span>
            <span>DEFAULTS: <span className="text-[#ff2020] font-semibold">{totalDefaults}</span></span>
          </>
        )}
      </div>

      <div className="flex items-center gap-4 text-[10px] text-[#4a7a9b]">
        <span>
          <span className="text-[#c8e6f5]">{totalNodes}</span> NODES
          <span className="mx-1 text-[rgba(0,200,255,0.3)]">/</span>
          <span className="text-[#c8e6f5]">{totalEdges}</span> EDGES
        </span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <span>LATENCY: <span className="text-[#00e5ff]">{lastLatencyUs}μs</span></span>
        <span className="text-[rgba(0,200,255,0.3)]">·</span>
        <div className="flex items-center gap-1">
          <div className={`status-dot ${status === 'connected' ? 'connected' : status === 'error' ? 'error' : ''}`} />
          <span className={status === 'connected' ? 'text-[#00e5ff]' : status === 'error' ? 'text-[#ff2020]' : 'text-[#4a7a9b]'}>
            {status.toUpperCase()}
          </span>
          {reconnectCount > 0 && <span className="text-[#4a7a9b]">×{reconnectCount}</span>}
        </div>
      </div>
    </div>
  );
}
