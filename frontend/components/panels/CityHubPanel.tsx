'use client';

import { useMemo } from 'react';
import { useUIStore } from '@/store/uiStore';
import { useGraphStore } from '@/store/graphStore';
import NodeInfoCard from './NodeInfoCard';

function fmt(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  return `$${n.toFixed(0)}`;
}

const STATE_COLORS: Record<string, string> = {
  idle:      '#4a7a9b',
  stressed:  '#ff8c00',
  critical:  '#ff5000',
  defaulted: '#ff2020',
};

const HUB_COLORS: Record<string, string> = {
  NYC:      '#00e5ff',
  London:   '#a78bfa',
  Tokyo:    '#f59e0b',
  HongKong: '#4ade80',
  Dubai:    '#fb923c',
};

export default function CityHubPanel() {
  const selectedCityName = useUIStore(s => s.selectedCityName);
  const setSelectedCity  = useUIStore(s => s.setSelectedCity);
  const selectedNodeId   = useUIStore(s => s.selectedNodeId);
  const setSelectedNode  = useUIStore(s => s.setSelectedNode);
  const nodes            = useGraphStore(s => s.nodes);

  // selectedCityName is either a hub name (NYC, London…) from hub mode
  // or a city name (New York, Frankfurt…) from city-level selection
  const HUB_NAMES = new Set(['NYC', 'London', 'Tokyo', 'HongKong', 'Dubai']);
  const isHubLevel = HUB_NAMES.has(selectedCityName ?? '');

  const { cityFirms, hub, totalNav } = useMemo(() => {
    if (!selectedCityName) return { cityFirms: [], hub: '', totalNav: 0 };
    const list = Array.from(nodes.values())
      .filter(n => isHubLevel ? n.hub === selectedCityName : n.cityName === selectedCityName)
      .sort((a, b) => b.nav - a.nav);
    return {
      cityFirms: list,
      hub: isHubLevel ? selectedCityName : (list[0]?.hub ?? ''),
      totalNav: list.reduce((s, n) => s + n.nav, 0),
    };
  }, [selectedCityName, nodes, isHubLevel]);

  if (!selectedCityName) return null;

  const hubColor = HUB_COLORS[hub] ?? '#00e5ff';

  return (
    <div
      className="panel-bracket w-72 text-[#c8e6f5] flex flex-col max-h-[80vh]"
      style={{ fontFamily: 'Chakra Petch, sans-serif' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(0,200,255,0.1)' }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-wide">
            {isHubLevel ? `${selectedCityName} HUB` : selectedCityName}
          </span>
          {!isHubLevel && (
            <span
              className="text-[9px] px-1.5 py-0.5 font-semibold tracking-widest"
              style={{ color: hubColor, border: `1px solid ${hubColor}40`, background: `${hubColor}12` }}
            >
              {hub}
            </span>
          )}
        </div>
        <button
          onClick={() => setSelectedCity(null)}
          className="text-[#4a7a9b] hover:text-[#c8e6f5] text-xs transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Stats row */}
      <div
        className="flex items-center gap-4 px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(0,200,255,0.06)' }}
      >
        <div>
          <div className="text-[9px] tracking-widest text-[#4a7a9b]">FIRMS</div>
          <div className="font-mono text-xs font-semibold text-[#00e5ff]">{cityFirms.length}</div>
        </div>
        <div>
          <div className="text-[9px] tracking-widest text-[#4a7a9b]">TOTAL NAV</div>
          <div className="font-mono text-xs font-semibold text-[#c8e6f5]">{fmt(totalNav)}</div>
        </div>
      </div>

      {/* Embedded node info card — shown collapsed when a firm is selected */}
      {selectedNodeId !== null && (
        <div
          className="flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(0,200,255,0.1)' }}
        >
          <NodeInfoCard embedded />
        </div>
      )}

      {/* Firm list */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {cityFirms.map((n, i) => {
          const isSelected = n.id === selectedNodeId;
          return (
            <div
              key={n.id}
              className="flex items-center gap-2 px-3 py-2 cursor-pointer transition-colors"
              style={{
                borderBottom: '1px solid rgba(0,200,255,0.04)',
                background: isSelected ? 'rgba(0,229,255,0.05)' : 'transparent',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? 'rgba(0,229,255,0.07)' : 'rgba(255,255,255,0.03)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = isSelected ? 'rgba(0,229,255,0.05)' : 'transparent'; }}
              onClick={() => setSelectedNode(n.id, [])}
            >
              <span className="font-mono text-[9px] text-[#2a4a6a] w-5 flex-shrink-0">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="text-[10px] flex-1 truncate" style={{ color: isSelected ? '#00e5ff' : '#c8e6f5' }}>
                {n.isHeroFirm ? '◆ ' : ''}{n.firmName}
              </span>
              <span className="font-mono text-[10px] text-[#4a7a9b] flex-shrink-0">{fmt(n.nav)}</span>
              <span
                className="text-[8px] px-1 py-0.5 tracking-widest flex-shrink-0"
                style={{ color: STATE_COLORS[n.state], border: `1px solid ${STATE_COLORS[n.state]}40` }}
              >
                {n.state.toUpperCase()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
