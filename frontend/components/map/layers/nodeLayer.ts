import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { GraphNode } from '@/types/graph';
import { nodeStateColor } from '@/types/graph';

interface NodeLayerOptions {
  nodes: GraphNode[];
  hoveredNodeId: number | null;
  hoveredNeighborIds: Set<number>;
  selectedNodeId: number | null;
  highlightedIds: Set<number>;
  onHover: (nodeId: number | null) => void;
  onSelect: (node: GraphNode | null) => void;
}

// Muted slate-grey used when a node is outside the focus set.
const DIM_RGB: [number, number, number] = [70, 90, 110];
const DIM_DOT_ALPHA = 22;
const DIM_GLOW_ALPHA = 0;

function getDotRadius(
  n: GraphNode,
  hoveredId: number | null,
  selectedId: number | null,
  isDimmed: boolean,
): number {
  if (isDimmed) return 1.5;
  if (n.id === selectedId) return 7;
  if (n.id === hoveredId) return 6;
  if (n.isHeroFirm) return 6;
  if (n.state === 'defaulted') return 5;
  return 4;
}

function getGlowRadius(
  n: GraphNode,
  hoveredId: number | null,
  selectedId: number | null,
  isDimmed: boolean,
): number {
  if (isDimmed) return 0;
  if (n.id === selectedId) return 18;
  if (n.id === hoveredId) return 16;
  if (n.isHeroFirm) return 14;
  if (n.state === 'defaulted') return 14;
  if (n.state === 'critical') return 12;
  return 10;
}

export function buildNodeLayers(opts: NodeLayerOptions): Layer[] {
  const {
    nodes,
    hoveredNodeId,
    hoveredNeighborIds,
    selectedNodeId,
    highlightedIds,
    onHover,
    onSelect,
  } = opts;

  const focusActive = hoveredNodeId !== null || selectedNodeId !== null;
  const isLit = (id: number) =>
    id === hoveredNodeId ||
    id === selectedNodeId ||
    highlightedIds.has(id) ||
    hoveredNeighborIds.has(id);

  const triggers = {
    getFillColor: [hoveredNodeId, selectedNodeId, highlightedIds, hoveredNeighborIds],
    getRadius:    [hoveredNodeId, selectedNodeId, highlightedIds, hoveredNeighborIds],
  };

  const glowLayer = new ScatterplotLayer<GraphNode>({
    id: 'nodes-glow',
    data: nodes,
    pickable: false,
    stroked: false,
    filled: true,
    radiusUnits: 'pixels',
    radiusMinPixels: 0,
    radiusMaxPixels: 20,
    getPosition: (n) => [n.lon, n.lat],
    getRadius: (n) => getGlowRadius(n, hoveredNodeId, selectedNodeId, focusActive && !isLit(n.id)),
    getFillColor: (n) => {
      if (focusActive && !isLit(n.id)) {
        return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], DIM_GLOW_ALPHA];
      }
      const [r, g, b] = nodeStateColor(n.state, n.isHeroFirm);
      const alpha = n.id === selectedNodeId || n.id === hoveredNodeId ? 45 : 20;
      return [r, g, b, alpha];
    },
    updateTriggers: triggers,
    transitions: {
      getFillColor: 150,
      getRadius: 150,
    },
  });

  const dotLayer = new ScatterplotLayer<GraphNode>({
    id: 'nodes-dot',
    data: nodes,
    pickable: true,
    stroked: false,
    filled: true,
    radiusUnits: 'pixels',
    radiusMinPixels: 2,
    radiusMaxPixels: 8,
    getPosition: (n) => [n.lon, n.lat],
    getRadius: (n) => getDotRadius(n, hoveredNodeId, selectedNodeId, focusActive && !isLit(n.id)),
    getFillColor: (n) => {
      if (focusActive && !isLit(n.id)) {
        return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], DIM_DOT_ALPHA];
      }
      return nodeStateColor(n.state, n.isHeroFirm);
    },
    onHover: (info) => onHover(info.object ? info.object.id : null),
    onClick: (info) => onSelect(info.object ?? null),
    updateTriggers: triggers,
    transitions: {
      getFillColor: 150,
      getRadius: 150,
    },
  });

  return [glowLayer, dotLayer];
}
