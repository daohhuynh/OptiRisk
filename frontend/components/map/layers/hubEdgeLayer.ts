import { ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { HubEdge } from '@/lib/graph/cityHubs';

interface HubEdgeLayerOptions {
  edges: HubEdge[];
  hoveredHubName: string | null;
  selectedHubName: string | null;
  opacity?: number;
}

const DIM: [number, number, number, number] = [90, 110, 130, 6];

export function buildHubEdgeLayer(opts: HubEdgeLayerOptions): Layer[] {
  const { edges, hoveredHubName, selectedHubName, opacity = 1 } = opts;

  const focusName   = hoveredHubName ?? selectedHubName;
  const focusActive = focusName !== null;
  const isFocused   = (e: HubEdge) => focusActive && (e.sourceHub === focusName || e.targetHub === focusName);
  const isDimmed    = (e: HubEdge) => focusActive && !isFocused(e);

  const maxAmount = edges.reduce((m, e) => Math.max(m, e.totalAmount), 1);

  const triggers = {
    getWidth:       [hoveredHubName, selectedHubName],
    getSourceColor: [hoveredHubName, selectedHubName],
    getTargetColor: [hoveredHubName, selectedHubName],
  };

  const transitions = { getWidth: 120, getSourceColor: 120, getTargetColor: 120 };

  const shared = {
    data: edges,
    pickable: false,
    opacity,
    getSourcePosition: (e: HubEdge) => e.source,
    getTargetPosition: (e: HubEdge) => e.target,
    getHeight: 0.25,
    getTilt: 25,
    widthUnits: 'pixels' as const,
  };

  // Glow pass — only on focused edges
  const glowLayer = new ArcLayer<HubEdge>({
    ...shared,
    id: 'hub-edges-glow',
    getWidth: (e) => isFocused(e) ? 8 : 0,
    getSourceColor: (e) => isFocused(e) ? [0, 229, 255, 25] : [0, 0, 0, 0],
    getTargetColor: (e) => isFocused(e) ? [0, 229, 255, 15] : [0, 0, 0, 0],
    updateTriggers: triggers,
    transitions,
  });

  // Core pass
  const coreLayer = new ArcLayer<HubEdge>({
    ...shared,
    id: 'hub-edges-core',
    getWidth: (e) => {
      if (isDimmed(e)) return 0;
      const base = Math.max(0.6, Math.min(2.5, (e.totalAmount / maxAmount) * 3));
      return isFocused(e) ? base * 1.4 : base;
    },
    getSourceColor: (e) => {
      if (isDimmed(e)) return DIM;
      if (isFocused(e)) return [0, 229, 255, 160];
      return [84, 105, 127, 50];
    },
    getTargetColor: (e) => {
      if (isDimmed(e)) return DIM;
      if (isFocused(e)) return [0, 229, 255, 90];
      return [84, 105, 127, 50];
    },
    updateTriggers: triggers,
    transitions,
  });

  return [glowLayer, coreLayer];
}
