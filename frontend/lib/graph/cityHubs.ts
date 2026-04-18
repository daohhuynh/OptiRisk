import type { GraphNode, NodeState } from '@/types/graph';
import type { GraphEdge } from '@/types/graph';

// ── City-level (used by CityHubPanel firm list) ────────────────────────────

export interface CityHub {
  cityName: string;
  hub: string;
  lat: number;
  lon: number;
  nodeCount: number;
  totalNav: number;
  worstState: NodeState;
  nodes: GraphNode[];
}

function worstOf(states: NodeState[]): NodeState {
  if (states.includes('defaulted')) return 'defaulted';
  if (states.includes('critical')) return 'critical';
  if (states.includes('stressed')) return 'stressed';
  return 'idle';
}

export function deriveCityHubs(nodes: GraphNode[]): CityHub[] {
  const acc = new Map<string, { nodes: GraphNode[]; sumLat: number; sumLon: number }>();
  for (const n of nodes) {
    const e = acc.get(n.cityName) ?? { nodes: [], sumLat: 0, sumLon: 0 };
    e.nodes.push(n);
    e.sumLat += n.lat;
    e.sumLon += n.lon;
    acc.set(n.cityName, e);
  }
  return Array.from(acc.entries()).map(([cityName, { nodes, sumLat, sumLon }]) => ({
    cityName,
    hub: nodes[0].hub,
    lat: sumLat / nodes.length,
    lon: sumLon / nodes.length,
    nodeCount: nodes.length,
    totalNav: nodes.reduce((s, n) => s + n.nav, 0),
    worstState: worstOf(nodes.map(n => n.state)),
    nodes: [...nodes].sort((a, b) => b.nav - a.nav),
  }));
}

// ── Hub-level (5 blobs shown at zoom < 4) ─────────────────────────────────

// Primary anchor for each hub's visual blob center
const HUB_CENTERS: Record<string, { lat: number; lon: number }> = {
  NYC:      { lat: 40.75,  lon: -74.00 },
  London:   { lat: 51.51,  lon:  -0.13 },
  Tokyo:    { lat: 35.70,  lon: 139.72 },
  HongKong: { lat: 22.40,  lon: 114.13 },
  Dubai:    { lat: 25.20,  lon:  55.27 },
};

export interface HubAggregate {
  hubName: string;
  lat: number;
  lon: number;
  nodeCount: number;
  totalNav: number;
  worstState: NodeState;
}

export function deriveHubAggregates(nodes: GraphNode[]): HubAggregate[] {
  const acc = new Map<string, { count: number; nav: number; states: NodeState[] }>();
  for (const n of nodes) {
    const e = acc.get(n.hub) ?? { count: 0, nav: 0, states: [] };
    e.count++;
    e.nav += n.nav;
    e.states.push(n.state);
    acc.set(n.hub, e);
  }
  return Array.from(acc.entries()).map(([hubName, { count, nav, states }]) => {
    const center = HUB_CENTERS[hubName] ?? { lat: 0, lon: 0 };
    return {
      hubName,
      lat: center.lat,
      lon: center.lon,
      nodeCount: count,
      totalNav: nav,
      worstState: worstOf(states),
    };
  });
}

// ── Inter-city aggregate edges ────────────────────────────────────────────

export interface CityEdge {
  key: string;
  source: [number, number];
  target: [number, number];
  totalAmount: number;
}

export function deriveCityEdges(nodes: GraphNode[], edges: GraphEdge[]): CityEdge[] {
  // Build per-node city centroid lookup
  const cityPos = new Map<string, { sumLat: number; sumLon: number; count: number }>();
  for (const n of nodes) {
    const e = cityPos.get(n.cityName) ?? { sumLat: 0, sumLon: 0, count: 0 };
    e.sumLat += n.lat; e.sumLon += n.lon; e.count++;
    cityPos.set(n.cityName, e);
  }
  const cityCenter = new Map<string, [number, number]>();
  for (const [name, { sumLat, sumLon, count }] of cityPos) {
    cityCenter.set(name, [sumLon / count, sumLat / count]);
  }

  const nodeCity = new Map<number, string>();
  for (const n of nodes) nodeCity.set(n.id, n.cityName);

  const agg = new Map<string, number>();
  for (const e of edges) {
    const src = nodeCity.get(e.debtorId);
    const tgt = nodeCity.get(e.creditorId);
    if (!src || !tgt || src === tgt) continue;
    const key = src < tgt ? `${src}||${tgt}` : `${tgt}||${src}`;
    agg.set(key, (agg.get(key) ?? 0) + e.amount);
  }

  const result: CityEdge[] = [];
  for (const [key, totalAmount] of agg) {
    const [a, b] = key.split('||');
    const ca = cityCenter.get(a);
    const cb = cityCenter.get(b);
    if (!ca || !cb) continue;
    result.push({ key, source: ca, target: cb, totalAmount });
  }
  return result;
}

// ── Inter-hub aggregate edges ──────────────────────────────────────────────

export interface HubEdge {
  key: string;
  sourceHub: string;
  targetHub: string;
  source: [number, number];
  target: [number, number];
  totalAmount: number;
}

export function deriveHubEdges(nodes: GraphNode[], edges: GraphEdge[]): HubEdge[] {
  const nodeHub = new Map<number, string>();
  for (const n of nodes) nodeHub.set(n.id, n.hub);

  const agg = new Map<string, number>();
  for (const e of edges) {
    const src = nodeHub.get(e.debtorId);
    const tgt = nodeHub.get(e.creditorId);
    if (!src || !tgt || src === tgt) continue;
    // canonical key: alphabetical order so A→B and B→A merge
    const key = src < tgt ? `${src}:${tgt}` : `${tgt}:${src}`;
    agg.set(key, (agg.get(key) ?? 0) + e.amount);
  }

  return Array.from(agg.entries()).map(([key, totalAmount]) => {
    const [a, b] = key.split(':');
    const ca = HUB_CENTERS[a] ?? { lat: 0, lon: 0 };
    const cb = HUB_CENTERS[b] ?? { lat: 0, lon: 0 };
    return {
      key,
      sourceHub: a,
      targetHub: b,
      source: [ca.lon, ca.lat] as [number, number],
      target: [cb.lon, cb.lat] as [number, number],
      totalAmount,
    };
  });
}
