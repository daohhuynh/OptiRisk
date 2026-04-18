import { TextLayer } from '@deck.gl/layers';
import type { GraphNode } from '@/types/graph';

interface LabelLayerOptions {
  nodes: GraphNode[];
  hoveredNodeId: number | null;
  hoveredNeighborIds: Set<number>;
  selectedNodeId: number | null;
  highlightedIds: Set<number>;
  zoom: number;
  labelsReady?: boolean;
}

// When focus is active, a city with more than this many lit firms collapses
// into a single "CITY · N" cluster label (the focus anchor itself is always
// kept as an individual firm label, even inside a collapsed city).
const CLUSTER_THRESHOLD = 3;

type LabelDatum =
  | { kind: 'firm'; node: GraphNode }
  | { kind: 'cluster'; city: string; lat: number; lon: number; count: number };

function buildFocusLabels(
  nodes: GraphNode[],
  isLit: (id: number) => boolean,
  anchorId: number | null,
): LabelDatum[] {
  // Group lit firms by city, tracking centroid and whether the anchor is inside.
  type Bucket = {
    city: string;
    sumLat: number;
    sumLon: number;
    count: number;
    anchorMember: GraphNode | null;
    members: GraphNode[];
  };
  const buckets = new Map<string, Bucket>();

  for (const n of nodes) {
    if (!isLit(n.id)) continue;
    let b = buckets.get(n.cityName);
    if (!b) {
      b = { city: n.cityName, sumLat: 0, sumLon: 0, count: 0, anchorMember: null, members: [] };
      buckets.set(n.cityName, b);
    }
    b.sumLat += n.lat;
    b.sumLon += n.lon;
    b.count++;
    b.members.push(n);
    if (n.id === anchorId) b.anchorMember = n;
  }

  const out: LabelDatum[] = [];
  for (const b of buckets.values()) {
    if (b.count > CLUSTER_THRESHOLD) {
      // Collapse into a single cluster label at the city centroid.
      // Always preserve the anchor firm as its own label so the user still
      // sees the name of the firm they selected/hovered.
      out.push({
        kind: 'cluster',
        city: b.city,
        lat: b.sumLat / b.count,
        lon: b.sumLon / b.count,
        count: b.anchorMember ? b.count - 1 : b.count,
      });
      if (b.anchorMember) out.push({ kind: 'firm', node: b.anchorMember });
    } else {
      // Few enough lit firms — show them all individually.
      for (const n of b.members) out.push({ kind: 'firm', node: n });
    }
  }
  return out;
}

export function buildLabelLayer(opts: LabelLayerOptions): TextLayer<LabelDatum> {
  const { nodes, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, zoom, labelsReady } = opts;

  if (!(labelsReady ?? true)) {
    return new TextLayer<LabelDatum>({ id: 'labels', data: [] });
  }

  const focusActive = hoveredNodeId !== null || selectedNodeId !== null;
  const isLit = (id: number) =>
    id === hoveredNodeId ||
    id === selectedNodeId ||
    highlightedIds.has(id) ||
    hoveredNeighborIds.has(id);

  // The anchor is whichever focus the user is currently driving (selection
  // wins over hover). It's always preserved as an individual label.
  const anchorId = selectedNodeId ?? hoveredNodeId;

  // Two regimes:
  //   - focusActive: build lit-firm + city-cluster labels (this builder).
  //   - idle: progressive zoom-based reveal of important firms only.
  const data: LabelDatum[] = focusActive
    ? buildFocusLabels(nodes, isLit, anchorId)
    : nodes
        .filter((n) => {
          if (n.isHeroFirm) return true;
          if (n.state === 'defaulted' || n.state === 'critical') return true;
          if (zoom >= 5) return true;
          if (zoom >= 4) return n.nav > 5e8;
          if (zoom >= 3) return n.nav > 2e9;
          return false;
        })
        .map((n) => ({ kind: 'firm', node: n }) as LabelDatum);

  return new TextLayer<LabelDatum>({
    id: 'labels',
    data,
    pickable: false,

    getPosition: (d) =>
      d.kind === 'cluster' ? [d.lon, d.lat] : [d.node.lon, d.node.lat],

    getText: (d) => {
      if (d.kind === 'cluster') return `${d.city.toUpperCase()} · ${d.count}`;
      const n = d.node;
      const prefix = n.isHeroFirm ? '◆ ' : '';
      const isHoverContext = n.id === hoveredNodeId || hoveredNeighborIds.has(n.id);
      if (isHoverContext && n.id !== selectedNodeId) return `${prefix}${n.firmName}, ${n.cityName}`;
      return `${prefix}${n.firmName}`;
    },

    getSize: (d) => {
      if (d.kind === 'cluster') return 11;
      const n = d.node;
      if (n.id === selectedNodeId) return 13;
      if (n.id === hoveredNodeId || n.isHeroFirm) return 11;
      if (n.state === 'defaulted') return 11;
      return 9;
    },

    getColor: (d) => {
      if (d.kind === 'cluster') return [120, 200, 230, 230];
      const n = d.node;
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
