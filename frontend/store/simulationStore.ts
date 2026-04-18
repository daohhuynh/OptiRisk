import { create } from 'zustand';
import type { SimPhase, SimEvent, ShockConfig, VaRReportMsg, MarketAnchorsMsg } from '@/types/simulation';

interface SimulationState {
  phase: SimPhase;
  currentTick: number;
  shockOriginNodeId: number | null;
  activeShockConfig: ShockConfig | null;
  events: SimEvent[];
  latestVaR: VaRReportMsg | null;
  marketAnchors: MarketAnchorsMsg | null;
  totalDefaults: number;
  setPhase: (phase: SimPhase) => void;
  setTick: (tick: number) => void;
  setShockOrigin: (nodeId: number | null) => void;
  recordShockSent: (config: ShockConfig) => void;
  addEvent: (event: SimEvent) => void;
  applyVaRReport: (msg: VaRReportMsg) => void;
  setMarketAnchors: (msg: MarketAnchorsMsg) => void;
  incrementDefaults: () => void;
  reset: () => void;
}

function makeId() { return Math.random().toString(36).slice(2, 9); }

export const useSimulationStore = create<SimulationState>((set) => ({
  phase: 'pre_shock',
  currentTick: 0,
  shockOriginNodeId: null,
  activeShockConfig: null,
  events: [],
  latestVaR: null,
  marketAnchors: null,
  totalDefaults: 0,

  setPhase: (phase) => set({ phase }),
  setTick: (tick) => set({ currentTick: tick }),
  setShockOrigin: (nodeId) => set({ shockOriginNodeId: nodeId }),

  recordShockSent: (config) => {
    const event: SimEvent = {
      id: makeId(),
      type: 'shock_sent',
      timestamp: Date.now(),
      label: `> SHOCK_${config.shockType.toUpperCase()} → NODE_${config.targetNodeId === 0xFFFFFFFF ? 'ALL' : config.targetNodeId}`,
      shockType: config.shockType,
      nodeId: config.targetNodeId,
    };
    set((s) => ({
      phase: 'shock_triggered' as SimPhase,
      activeShockConfig: config,
      shockOriginNodeId: config.targetNodeId === 0xFFFFFFFF ? null : config.targetNodeId,
      events: [...s.events.slice(-99), event],
    }));
  },

  addEvent: (event) => set((s) => ({ events: [...s.events.slice(-99), event] })),

  applyVaRReport: (msg) => {
    const event: SimEvent = {
      id: makeId(),
      type: 'var_report',
      timestamp: Date.now(),
      label: `> VAR_95 NODE_${msg.targetNode}: $${(msg.var95 / 1e6).toFixed(1)}M (${msg.pathsRun} paths)`,
      nodeId: msg.targetNode,
      var95: msg.var95,
    };
    set((s) => ({ latestVaR: msg, events: [...s.events.slice(-99), event] }));
  },

  setMarketAnchors: (msg) => set({ marketAnchors: msg }),
  incrementDefaults: () => set((s) => ({ totalDefaults: s.totalDefaults + 1 })),

  reset: () => set({
    phase: 'pre_shock',
    currentTick: 0,
    shockOriginNodeId: null,
    activeShockConfig: null,
    events: [],
    latestVaR: null,
    totalDefaults: 0,
  }),
}));
