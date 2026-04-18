import type { GraphEdge, GraphNode } from '@/types/graph';

// One merged arc: from the focused anchor out to a destination city. When the
// city only contains one connected firm, target points at that firm's actual
// coordinates (so the arc still pins to a precise dot); otherwise target is
// the centroid of the connected firms in that city.
export interface FocusEdge {
  source: [number, number];
  target: [number, number];
  destCityName: string;
  count: number;          // # of firm-to-firm edges folded into this arc
  totalAmount: number;    // sum of underlying edge amounts
  asDebtor: number;       // anchor was debtor in this many edges
  asCreditor: number;     // anchor was creditor in this many edges
  singleNodeId: number | null; // non-null when count === 1
}

// Per-node edge index: edges[i] = every GraphEdge that touches node i (in
// either direction). Built once per edges-list change; lookup per focus is
// O(degree) instead of O(|E|).
export function buildEdgeIndex(edges: GraphEdge[]): Map<number, GraphEdge[]> {
  const idx = new Map<number, GraphEdge[]>();
  for (const e of edges) {
    let a = idx.get(e.debtorId);
    if (!a) { a = []; idx.set(e.debtorId, a); }
    a.push(e);
    let b = idx.get(e.creditorId);
    if (!b) { b = []; idx.set(e.creditorId, b); }
    b.push(e);
  }
  return idx;
}

export function deriveFocusEdges(
  focusedId: number | null,
  nodes: Map<number, GraphNode>,
  edgeIndex: Map<number, GraphEdge[]>,
): FocusEdge[] {
  if (focusedId === null) return [];
  const anchor = nodes.get(focusedId);
  if (!anchor) return [];

  type Bucket = {
    city: string;
    sumLat: number;
    sumLon: number;
    count: number;
    totalAmount: number;
    asDebtor: number;
    asCreditor: number;
    singleNode: GraphNode | null;
  };

  const buckets = new Map<string, Bucket>();
  const incident = edgeIndex.get(focusedId) ?? [];

  for (const edge of incident) {
    let neighborId: number;
    let asDebtorInc = 0;
    let asCreditorInc = 0;

    if (edge.debtorId === focusedId) {
      neighborId = edge.creditorId;
      asDebtorInc = 1;
    } else if (edge.creditorId === focusedId) {
      neighborId = edge.debtorId;
      asCreditorInc = 1;
    } else {
      continue;
    }

    const neighbor = nodes.get(neighborId);
    if (!neighbor) continue;

    let b = buckets.get(neighbor.cityName);
    if (!b) {
      b = {
        city: neighbor.cityName,
        sumLat: 0,
        sumLon: 0,
        count: 0,
        totalAmount: 0,
        asDebtor: 0,
        asCreditor: 0,
        singleNode: neighbor,
      };
      buckets.set(neighbor.cityName, b);
    }
    b.sumLat += neighbor.lat;
    b.sumLon += neighbor.lon;
    b.count += 1;
    b.totalAmount += edge.amount;
    b.asDebtor += asDebtorInc;
    b.asCreditor += asCreditorInc;
    // Once we see a second edge to this city, it's no longer a single-firm pin
    if (b.count > 1) b.singleNode = null;
  }

  const out: FocusEdge[] = [];
  for (const b of buckets.values()) {
    const target: [number, number] = b.singleNode
      ? [b.singleNode.lon, b.singleNode.lat]
      : [b.sumLon / b.count, b.sumLat / b.count];

    out.push({
      source: [anchor.lon, anchor.lat],
      target,
      destCityName: b.city,
      count: b.count,
      totalAmount: b.totalAmount,
      asDebtor: b.asDebtor,
      asCreditor: b.asCreditor,
      singleNodeId: b.singleNode ? b.singleNode.id : null,
    });
  }
  return out;
}
