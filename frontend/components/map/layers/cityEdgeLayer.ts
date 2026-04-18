import { ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { CityEdge } from '@/lib/graph/cityHubs';

interface CityEdgeLayerOptions {
  edges: CityEdge[];
  hoveredCityName: string | null;
  selectedCityName: string | null;
  opacity?: number;
}

const DIM: [number, number, number, number] = [90, 110, 130, 6];

export function buildCityEdgeLayer(opts: CityEdgeLayerOptions): Layer[] {
  const { edges, hoveredCityName, selectedCityName, opacity = 1 } = opts;

  const focusName   = hoveredCityName ?? selectedCityName;
  const focusActive = focusName !== null;
  const isFocused   = (e: CityEdge) => {
    const [a, b] = e.key.split('||');
    return focusActive && (a === focusName || b === focusName);
  };
  const isDimmed = (e: CityEdge) => focusActive && !isFocused(e);

  const maxAmount = edges.reduce((m, e) => Math.max(m, e.totalAmount), 1);

  const triggers = {
    getWidth:       [hoveredCityName, selectedCityName],
    getSourceColor: [hoveredCityName, selectedCityName],
    getTargetColor: [hoveredCityName, selectedCityName],
  };

  const transitions = { getWidth: 120, getSourceColor: 120, getTargetColor: 120 };

  const shared = {
    data: edges,
    pickable: false,
    opacity,
    getSourcePosition: (e: CityEdge) => e.source,
    getTargetPosition: (e: CityEdge) => e.target,
    getHeight: 0.2,
    getTilt: 25,
    widthUnits: 'pixels' as const,
  };

  // Glow pass — only on focused edges
  const glowLayer = new ArcLayer<CityEdge>({
    ...shared,
    id: 'city-edges-glow',
    getWidth: (e) => isFocused(e) ? 6 : 0,
    getSourceColor: (e) => isFocused(e) ? [0, 229, 255, 22] : [0, 0, 0, 0],
    getTargetColor: (e) => isFocused(e) ? [0, 229, 255, 13] : [0, 0, 0, 0],
    updateTriggers: triggers,
    transitions,
  });

  // Core pass
  const coreLayer = new ArcLayer<CityEdge>({
    ...shared,
    id: 'city-edges-core',
    getWidth: (e) => {
      if (isDimmed(e)) return 0;
      const base = Math.max(0.4, Math.min(1.8, (e.totalAmount / maxAmount) * 2.5));
      return isFocused(e) ? base * 3 : base;
    },
    getSourceColor: (e) => {
      if (isDimmed(e)) return DIM;
      if (isFocused(e)) return [0, 229, 255, 160];
      return [84, 105, 127, 40];
    },
    getTargetColor: (e) => {
      if (isDimmed(e)) return DIM;
      if (isFocused(e)) return [0, 229, 255, 90];
      return [84, 105, 127, 40];
    },
    updateTriggers: triggers,
    transitions,
  });

  return [glowLayer, coreLayer];
}
