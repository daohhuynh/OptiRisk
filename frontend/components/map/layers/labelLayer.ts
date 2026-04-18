import { TextLayer } from '@deck.gl/layers';
import type { GraphNode } from '@/types/graph';

interface LabelLayerOptions {
  nodes: GraphNode[];
  hoveredNodeId: number | null;
  hoveredNeighborIds: Set<number>;
  selectedNodeId: number | null;
  highlightedIds: Set<number>;
  zoom: number;
}

export function buildLabelLayer(opts: LabelLayerOptions): TextLayer<GraphNode> {
  const { nodes, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, zoom } = opts;

  const focusActive = hoveredNodeId !== null || selectedNodeId !== null;
  const isLit = (id: number) =>
    id === hoveredNodeId ||
    id === selectedNodeId ||
    highlightedIds.has(id) ||
    hoveredNeighborIds.has(id);

  // When a focus is active, only show labels for the lit set. Otherwise, use the
  // progressive zoom-based reveal.
  const visibleNodes = focusActive
    ? nodes.filter((n) => isLit(n.id))
    : nodes.filter((n) => {
        if (n.isHeroFirm) return true;
        if (n.state === 'defaulted' || n.state === 'critical') return true;
        if (zoom >= 5) return true;
        if (zoom >= 4) return n.nav > 5e8;
        if (zoom >= 3) return n.nav > 2e9;
        return false;
      });

  return new TextLayer<GraphNode>({
    id: 'labels',
    data: visibleNodes,
    pickable: false,

    getPosition: (n) => [n.lon, n.lat],
    getText: (n) => {
      const prefix = n.isHeroFirm ? '◆ ' : '';
      const isHoverContext = n.id === hoveredNodeId || hoveredNeighborIds.has(n.id);
      if (isHoverContext && n.id !== selectedNodeId) return `${prefix}${n.firmName}, ${n.cityName}`;
      return `${prefix}${n.firmName}`;
    },

    getSize: (n) => {
      if (n.id === selectedNodeId) return 13;
      if (n.id === hoveredNodeId || n.isHeroFirm) return 11;
      if (n.state === 'defaulted') return 11;
      return 9;
    },

    getColor: (n) => {
      if (n.id === selectedNodeId) return [0, 229, 255, 255];
      if (n.isHeroFirm) return [168, 85, 247, 255];
      if (n.state === 'defaulted') return [255, 32, 32, 220];
      if (n.state === 'critical') return [255, 80, 0, 200];
      if (n.id === hoveredNodeId) return [200, 230, 245, 220];
      return [74, 122, 155, 160];
    },

    getTextAnchor: 'start',
    getAlignmentBaseline: 'bottom',
    getPixelOffset: [8, 16],
    fontFamily: 'JetBrains Mono, monospace',
    fontWeight: '500',
    background: false,
    sizeUnits: 'pixels',

    // Always paint labels above nodes/arcs in 3D — combined with this layer's
    // position at the end of the `layers` array, text is never occluded.
    // (luma.gl 9 / deck.gl v9 API: `depthCompare: 'always'` replaces the
    // legacy `depthTest: false` flag.)
    parameters: { depthCompare: 'always' },

    updateTriggers: {
      getText: [selectedNodeId, hoveredNodeId, highlightedIds, hoveredNeighborIds],
      getSize: [hoveredNodeId, selectedNodeId],
      getColor: [hoveredNodeId, selectedNodeId],
    },
  });
}
