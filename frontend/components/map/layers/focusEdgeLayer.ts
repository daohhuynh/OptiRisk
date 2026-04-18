import { ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { FocusEdge } from '@/lib/graph/focusEdges';

interface FocusEdgeLayerOptions {
  edges: FocusEdge[];
  opacity?: number;
}

// Width scaling: log of count, clamped. A 50-firm city is visibly thicker
// than a 1-firm pin without being overwhelming. Single-firm passthrough
// arcs sit at the floor of the range so they read as "thin precise pins".
function widthFor(e: FocusEdge): number {
  const w = Math.log2(e.count + 1) * 0.8;
  return Math.max(0.9, Math.min(3.0, w));
}

// Glow halo width — keep the firm-layer-style 4–5x ratio between glow and
// core so merged arcs read as "neon beam with halo" rather than "ribbon".
function glowWidthFor(e: FocusEdge): number {
  return Math.max(6, widthFor(e) * 4.5);
}

export function buildFocusEdgeLayer(opts: FocusEdgeLayerOptions): Layer[] {
  const { edges, opacity = 1 } = opts;

  // Only animate getWidth — colors are static constants, and deck.gl asserts
  // that transitions can only target function-type accessors.
  const transitions = { getWidth: 120 };

  const shared = {
    data: edges,
    pickable: false,
    opacity,
    getSourcePosition: (e: FocusEdge) => e.source,
    getTargetPosition: (e: FocusEdge) => e.target,
    // Distance-scaled arc height so cross-continent merges arc higher than
    // intra-region ones. Matches the firm edge layer's behavior.
    getHeight: (e: FocusEdge) => {
      const dx = e.target[0] - e.source[0];
      const dy = e.target[1] - e.source[1];
      const dist = Math.hypot(dx, dy);
      return Math.min(0.5, 0.15 + dist / 180);
    },
    getTilt: 25,
    widthUnits: 'pixels' as const,
    transitions,
  };

  const glowLayer = new ArcLayer<FocusEdge>({
    ...shared,
    id: 'focus-edges-glow',
    getWidth: glowWidthFor,
    getSourceColor: [0, 229, 255, 28],
    getTargetColor: [0, 229, 255, 18],
  });

  // Bumped core alpha vs the firm-edge focused branch (200/120 instead of
  // 160/90) to compensate for the lack of stacking — a single merged arc
  // should read about as bright as the saturated stack of N firm arcs did.
  const coreLayer = new ArcLayer<FocusEdge>({
    ...shared,
    id: 'focus-edges-core',
    getWidth: widthFor,
    getSourceColor: [0, 229, 255, 200],
    getTargetColor: [0, 229, 255, 120],
  });

  return [glowLayer, coreLayer];
}
