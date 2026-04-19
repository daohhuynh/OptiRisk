'use client';

import { useMemo, useState, useEffect } from 'react';
import { useUIStore } from '@/store/uiStore';
import { useGraphStore } from '@/store/graphStore';
import { useSimulationStore } from '@/store/simulationStore'; // [ADDED]
import { wsService } from '@/services/websocket';

const STATE_COLORS: Record<string, string> = {
  idle:      '#1a3a5c',
  stressed:  '#ff8c00',
  critical:  '#ff5000',
  defaulted: '#ff2020',
};

const STATE_BG: Record<string, string> = {
  idle:      'rgba(26,58,92,0.3)',
  stressed:  'rgba(255,140,0,0.2)',
  critical:  'rgba(255,80,0,0.2)',
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

interface NodeInfoCardProps {
  embedded?: boolean;
}

export default function NodeInfoCard({ embedded = false }: NodeInfoCardProps) {
  const selectedNodeId = useUIStore(s => s.selectedNodeId);
  const isNodeInfoOpen = useUIStore(s => s.isNodeInfoOpen);
  const clearSelection = useUIStore(s => s.clearSelection);
  const nodes          = useGraphStore(s => s.nodes);
  
  // [ADDED] Pull the latest VaR report from the simulation store
  const latestVaR      = useSimulationStore(s => s.latestVaR); 

  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => { setIsExpanded(false); }, [selectedNodeId]);

  const node = useMemo(() =>
    selectedNodeId !== null ? nodes.get(selectedNodeId) ?? null : null,
    [selectedNodeId, nodes],
  );

  if (!isNodeInfoOpen || !node) return null;

  // [CLEANED UP] The VaR Request function
  const requestMonteCarloVaR = () => {
    if (!node) return;
    const buffer = new ArrayBuffer(60); 
    const view = new DataView(buffer);
    view.setUint8(0, 0x01); 
    view.setUint16(2, 56, true);
    view.setUint32(4, node.id, true); 
    view.setUint32(8, 0xFE, true); // MAGIC SHOCK_TYPE: 0xFE = VaR Request
    wsService.sendBinary(buffer);
  };

  const stateColor = STATE_COLORS[node.state] ?? '#4a7a9b';
  const stateBg    = STATE_BG[node.state]    ?? 'transparent';

  const portfolio = node.portfolio;
  const total = portfolio.equities + portfolio.realEstate + portfolio.crypto + portfolio.treasuries + portfolio.corpBonds;
  const portfolioItems = [
    { label: 'EQ', value: portfolio.equities,   color: '#4ade80' },
    { label: 'RE', value: portfolio.realEstate, color: '#60a5fa' },
    { label: 'CR', value: portfolio.crypto,     color: '#f59e0b' },
    { label: 'TR', value: portfolio.treasuries, color: '#a78bfa' },
    { label: 'CB', value: portfolio.corpBonds,  color: '#34d399' },
  ];

  const outerClass = embedded
    ? 'text-[#c8e6f5] w-full'
    : 'panel-bracket w-64 text-[#c8e6f5]';

  const headerBorder = embedded
    ? 'border-b border-white/5'
    : 'border-b border-[rgba(0,200,255,0.1)]';

  return (
    <div className={outerClass} style={{ fontFamily: 'Chakra Petch, sans-serif' }}>
      {/* Collapsed strip — always visible, click to expand */}
      <div
        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer select-none ${headerBorder}`}
        onClick={() => setIsExpanded(v => !v)}
      >
        {node.isHeroFirm && <span className="text-[#a855f7] text-[10px]">◆</span>}
        <span className="text-xs font-semibold tracking-wide flex-1 truncate">
          {node.firmName}
        </span>
        <span
          className="text-[9px] px-1.5 py-0.5 font-semibold tracking-widest flex-shrink-0"
          style={{ color: stateColor, background: stateBg, border: `1px solid ${stateColor}40` }}
        >
          {node.state.toUpperCase()}
        </span>
        <span className="text-[#4a7a9b] text-[10px] flex-shrink-0">
          {isExpanded ? '▴' : '▾'}
        </span>
        {!embedded && (
          <button
            onClick={(e) => { e.stopPropagation(); clearSelection(); }}
            className="text-[#4a7a9b] hover:text-[#c8e6f5] text-xs transition-colors leading-none flex-shrink-0"
          >
            ✕
          </button>
        )}
      </div>

      {/* Expanded body */}
      {isExpanded && (
        <>
          {/* City / hub row */}
          <div
            className="flex items-center gap-2 px-3 py-1.5"
            style={{ borderBottom: '1px solid rgba(0,200,255,0.06)' }}
          >
            <span className="text-[#4a7a9b] text-[10px] tracking-widest">{node.cityName}</span>
            <span className="text-[#2a4a6a] text-[10px]">//</span>
            <span className="text-[#4a7a9b] text-[10px] tracking-widest">{node.hub}</span>
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
                    style={{ width: pct(node.riskScore), background: stateColor }}
                  />
                </div>
                <span className="font-mono text-[10px]" style={{ color: stateColor }}>
                  {pct(node.riskScore)}
                </span>
              </div>
            </div>
          </div>

          {/* Portfolio breakdown */}
          <div style={{ borderTop: '1px solid rgba(0,200,255,0.08)' }} className="px-3 py-2">
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

          {node.cascadeDepth > 0 && (
            <div
              className="px-3 py-1.5 flex justify-between items-center"
              style={{ borderTop: '1px solid rgba(255,32,32,0.2)', background: 'rgba(255,32,32,0.05)' }}
            >
              <span className="text-[9px] tracking-widest text-[#ff6060]">CASCADE DEPTH</span>
              <span className="font-mono text-xs text-[#ff2020] font-semibold">{node.cascadeDepth}</span>
            </div>
          )}

          {/* 🚀 VaR BUTTON AND HISTOGRAM 🚀 */}
          <div className="px-3 pb-3" style={{ borderTop: '1px solid rgba(0,200,255,0.08)' }}>
            <button 
              onClick={requestMonteCarloVaR}
              className="mt-2 w-full py-2 bg-red-900/40 hover:bg-red-800/80 text-red-200 text-[10px] tracking-widest font-bold rounded transition-colors"
            >
              COMPUTE MONTE CARLO VaR
            </button>
            
            {latestVaR && latestVaR.targetNode === node.id && (
              <div className="mt-3 p-2 bg-[#0a1628] border border-red-900/50 rounded font-mono">
                <div className="text-red-400 text-[9px] tracking-widest mb-1">P95 VaR (1,024 PATHS)</div>
                <div className="text-lg font-bold text-red-500 mb-2">
                  -${(latestVaR.var95 / 1e6).toFixed(2)}M
                </div>
            
                {/* Empirical Histogram Visualization */}
                <div className="flex items-end h-12 gap-[1px] mt-2 border-b border-gray-700/50">
                  {latestVaR.buckets.map((count, i) => {
                    const maxCount = Math.max(...latestVaR.buckets, 1);
                    const heightPct = (count / maxCount) * 100;
                    return (
                      <div 
                        key={i} 
                        className="flex-1 bg-red-600/60 hover:bg-red-400 transition-colors"
                        style={{ height: `${heightPct}%` }}
                        title={`Bucket ${i}: ${count} paths`}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}