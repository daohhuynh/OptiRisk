import { ArcLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { GraphEdge, GraphNode } from '@/types/graph';

export interface StableArcDatum {
  source: [number, number];
  target: [number, number];
  debtorId: number;
  creditorId: number;
}

export function buildStableEdgeData(
  edges: GraphEdge[],
  nodeMap: Map<number, GraphNode>,
): StableArcDatum[] {
  const result: StableArcDatum[] = [];
  for (const edge of edges) {
    const src = nodeMap.get(edge.debtorId);
    const tgt = nodeMap.get(edge.creditorId);
    if (!src || !tgt) continue;
    result.push({
      source: [src.lon, src.lat],
      target: [tgt.lon, tgt.lat],
      debtorId: edge.debtorId,
      creditorId: edge.creditorId,
    });
  }
  return result;
}

interface EdgeLayerOptions {
  hoveredNodeId: number | null;
  hoveredNeighborIds: Set<number>;
  selectedNodeId: number | null;
  highlightedIds: Set<number>;
  cascadeActive: boolean;
  defaultedNodeIds: Set<number>;
  opacity?: number;
  formedEdgeKeys?: Set<string>;  // key format: `${debtorId}:${creditorId}`
  isForming?: boolean;
  // When true, edges that touch the focus anchor are rendered fully
  // invisible — the merged focus-edge layer paints them instead. Non-focused
  // edges keep their normal dim treatment.
  mergedFocus?: boolean;
}

const DIM_EDGE_COLOR: [number, number, number, number] = [90, 110, 130, 6];

export function buildEdgeLayers(data: StableArcDatum[], opts: EdgeLayerOptions): Layer[] {
  const { hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, cascadeActive, defaultedNodeIds, opacity = 1, formedEdgeKeys, isForming, mergedFocus } = opts;

  const ekey = (d: StableArcDatum) => `${d.debtorId}:${d.creditorId}`;
  const isUnformed = (d: StableArcDatum) => (isForming ?? false) && !(formedEdgeKeys?.has(ekey(d)) ?? true);

  const focusActive  = hoveredNodeId !== null || selectedNodeId !== null;
  const isFocusAnchor = (id: number) => id === hoveredNodeId || id === selectedNodeId;
  const isFocused    = (d: StableArcDatum) => focusActive && (isFocusAnchor(d.debtorId) || isFocusAnchor(d.creditorId));
  const isActive     = (d: StableArcDatum) => cascadeActive && (defaultedNodeIds.has(d.debtorId) || defaultedNodeIds.has(d.creditorId));
  const isDimmed     = (d: StableArcDatum) => focusActive && !isFocused(d) && !isActive(d);
  // When merged-focus mode is on, hide focused individual edges entirely;
  // the merged focus-edge layer renders them as a single per-city arc. Cascade
  // (`isActive`) edges still paint normally so contagion stays visible.
  const isHiddenForMerge = (d: StableArcDatum) =>
    (mergedFocus ?? false) && isFocused(d) && !isActive(d);

  const triggers = {
    getWidth:       [hoveredNodeId, selectedNodeId, cascadeActive, defaultedNodeIds.size, highlightedIds, hoveredNeighborIds, formedEdgeKeys?.size ?? 0, mergedFocus ?? false],
    getSourceColor: [hoveredNodeId, selectedNodeId, cascadeActive, defaultedNodeIds.size, highlightedIds, hoveredNeighborIds, formedEdgeKeys?.size ?? 0, mergedFocus ?? false],
    getTargetColor: [hoveredNodeId, selectedNodeId, cascadeActive, defaultedNodeIds.size, highlightedIds, hoveredNeighborIds, formedEdgeKeys?.size ?? 0, mergedFocus ?? false],
    getHeight:      [hoveredNodeId, selectedNodeId, highlightedIds, hoveredNeighborIds],
  };

  const transitions = { getWidth: 120, getSourceColor: 120, getTargetColor: 120 };

  const shared = {
    data,
    pickable: false,
    opacity,
    getSourcePosition: (d: StableArcDatum) => d.source,
    getTargetPosition: (d: StableArcDatum) => d.target,
    getHeight: (d: StableArcDatum) => {
      const dx = d.target[0] - d.source[0];
      const dy = d.target[1] - d.source[1];
      const dist = Math.hypot(dx, dy);
      const base = Math.min(0.4, 0.1 + dist / 200);
      return isFocused(d) ? base * 1.5 : base;
    },
    getTilt: 25,
    widthUnits: 'pixels' as const,
  };

  const TRANSPARENT: [number, number, number, number] = [0, 0, 0, 0];

  const glowLayer = new ArcLayer<StableArcDatum>({
    ...shared,
    id: 'edges-glow',
    getWidth: (d) => {
      if (isHiddenForMerge(d)) return 0;
      if (isUnformed(d)) return 0;
      if (isActive(d)) return 8;
      if (isFocused(d)) return 6;
      return 0;
    },
    getSourceColor: (d) => {
      if (isHiddenForMerge(d)) return TRANSPARENT;
      if (isUnformed(d)) return TRANSPARENT;
      if (isActive(d)) return [255, 80, 0, 30];
      if (isFocused(d)) return [0, 229, 255, 25];
      return TRANSPARENT;
    },
    getTargetColor: (d) => {
      if (isHiddenForMerge(d)) return TRANSPARENT;
      if (isUnformed(d)) return TRANSPARENT;
      if (isActive(d)) return [255, 32, 32, 30];
      if (isFocused(d)) return [0, 229, 255, 15];
      return TRANSPARENT;
    },
    updateTriggers: triggers,
    transitions,
  });

  const coreLayer = new ArcLayer<StableArcDatum>({
    ...shared,
    id: 'edges-core',
    getWidth: (d) => {
      if (isHiddenForMerge(d)) return 0;
      if (isUnformed(d)) return 0;
      if (isActive(d)) return 1.5;
      if (isFocused(d)) return 1.2;
      if (isDimmed(d)) return 0;
      return 0.6;
    },
    getSourceColor: (d) => {
      if (isHiddenForMerge(d)) return TRANSPARENT;
      if (isUnformed(d)) return TRANSPARENT;
      if (isActive(d)) return [255, 80, 0, 200];
      if (isFocused(d)) return [0, 229, 255, 160];
      if (isDimmed(d)) return DIM_EDGE_COLOR;
      return [84, 105, 127, 40];
    },
    getTargetColor: (d) => {
      if (isHiddenForMerge(d)) return TRANSPARENT;
      if (isUnformed(d)) return TRANSPARENT;
      if (isActive(d)) return [255, 32, 32, 220];
      if (isFocused(d)) return [0, 229, 255, 90];
      if (isDimmed(d)) return DIM_EDGE_COLOR;
      return [84, 105, 127, 40];
    },
    updateTriggers: triggers,
    transitions,
  });

  return [glowLayer, coreLayer];
}
