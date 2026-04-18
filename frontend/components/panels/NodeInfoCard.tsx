'use client';

import { useMemo } from 'react';
import { useUIStore } from '@/store/uiStore';
import { useGraphStore } from '@/store/graphStore';

const STATE_COLORS: Record<string, string> = {
  idle: '#1a3a5c',
  stressed: '#ff8c00',
  critical: '#ff5000',
  defaulted: '#ff2020',
};

const STATE_BG: Record<string, string> = {
  idle: 'rgba(26,58,92,0.3)',
  stressed: 'rgba(255,140,0,0.2)',
  critical: 'rgba(255,80,0,0.2)',
  defaulted: 'rgba(255,32,32,0.25)',
};

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default function NodeInfoCard() {
  // Granular selectors
  const selectedNodeId  = useUIStore(s => s.selectedNodeId);
  const isNodeInfoOpen  = useUIStore(s => s.isNodeInfoOpen);
  const clearSelection  = useUIStore(s => s.clearSelection);
  const nodes           = useGraphStore(s => s.nodes);

  const node = useMemo(() =>
    selectedNodeId !== null ? nodes.get(selectedNodeId) ?? null : null,
    [selectedNodeId, nodes]
  );

  if (!isNodeInfoOpen || !node) return null;

  const portfolio = node.portfolio;
  const total = portfolio.equities + portfolio.realEstate + portfolio.crypto + portfolio.treasuries + portfolio.corpBonds;
  const portfolioItems = [
    { label: 'EQ', value: portfolio.equities, color: '#4ade80' },
    { label: 'RE', value: portfolio.realEstate, color: '#60a5fa' },
    { label: 'CR', value: portfolio.crypto, color: '#f59e0b' },
    { label: 'TR', value: portfolio.treasuries, color: '#a78bfa' },
    { label: 'CB', value: portfolio.corpBonds, color: '#34d399' },
  ];

  const stateColor = STATE_COLORS[node.state] ?? '#4a7a9b';
  const stateBg = STATE_BG[node.state] ?? 'transparent';

  return (
    <div
      className="panel-bracket w-64 text-[#c8e6f5]"
      style={{ fontFamily: 'Chakra Petch, sans-serif' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid rgba(0,200,255,0.1)' }}
      >
        <div className="flex items-center gap-2">
          {node.isHeroFirm && (
            <span className="text-[#a855f7] text-xs">◆</span>
          )}
          <span className="text-xs font-semibold tracking-widest">
            {node.firmName}
          </span>
          <span className="text-[#4a7a9b] text-xs">//</span>
          <span className="text-[#4a7a9b] text-xs">{node.cityName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] px-1.5 py-0.5 font-semibold tracking-widest"
            style={{ color: stateColor, background: stateBg, border: `1px solid ${stateColor}40` }}
          >
            {node.state.toUpperCase()}
          </span>
          <button
            onClick={clearSelection}
            className="text-[#4a7a9b] hover:text-[#c8e6f5] text-xs transition-colors leading-none"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Balance sheet */}
      <div className="px-3 py-2 space-y-1.5">
        <div className="flex justify-between items-center">
          <span className="text-[#4a7a9b] text-[10px] tracking-widest">NAV</span>
          <span className="font-mono text-xs font-semibold" style={{ color: node.nav < 0 ? '#ff2020' : '#00e5ff' }}>
            {fmt(node.nav)}
          </span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[#4a7a9b] text-[10px] tracking-widest">ASSETS</span>
          <span className="font-mono text-xs text-[#c8e6f5]">{fmt(node.totalAssets)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[#4a7a9b] text-[10px] tracking-widest">LIAB</span>
          <span className="font-mono text-xs text-[#c8e6f5]">{fmt(node.liabilities)}</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-[#4a7a9b] text-[10px] tracking-widest">RISK</span>
          <div className="flex items-center gap-2">
            <div className="w-20 h-1.5 bg-[#0a1628] rounded-sm overflow-hidden">
              <div
                className="h-full transition-all duration-300"
                style={{
                  width: pct(node.riskScore),
                  background: stateColor,
                }}
              />
            </div>
            <span className="font-mono text-[10px]" style={{ color: stateColor }}>
              {pct(node.riskScore)}
            </span>
          </div>
        </div>
      </div>

      {/* Portfolio breakdown */}
      <div
        className="px-3 py-2"
        style={{ borderTop: '1px solid rgba(0,200,255,0.08)' }}
      >
        <div className="text-[#4a7a9b] text-[9px] tracking-widest mb-2">PORTFOLIO</div>
        <div className="space-y-1">
          {portfolioItems.map(({ label, value, color }) => (
            <div key={label} className="flex items-center gap-2">
              <span className="font-mono text-[9px] text-[#4a7a9b] w-4">{label}</span>
              <div className="flex-1 h-1 bg-[#0a1628] overflow-hidden">
                <div
                  className="h-full"
                  style={{ width: `${total > 0 ? (value / total) * 100 : 0}%`, background: color, opacity: 0.7 }}
                />
              </div>
              <span className="font-mono text-[9px] text-[#4a7a9b] w-10 text-right">
                {total > 0 ? ((value / total) * 100).toFixed(0) : 0}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Cascade depth if in cascade */}
      {node.cascadeDepth > 0 && (
        <div
          className="px-3 py-1.5 flex justify-between items-center"
          style={{ borderTop: '1px solid rgba(255,32,32,0.2)', background: 'rgba(255,32,32,0.05)' }}
        >
          <span className="text-[9px] tracking-widest text-[#ff6060]">CASCADE DEPTH</span>
          <span className="font-mono text-xs text-[#ff2020] font-semibold">{node.cascadeDepth}</span>
        </div>
      )}
    </div>
  );
}
