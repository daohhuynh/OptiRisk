export type HubName = 'NYC' | 'London' | 'Tokyo' | 'HongKong' | 'Dubai';
export type NodeState = 'idle' | 'stressed' | 'critical' | 'defaulted';
export type EdgeState = 'idle' | 'stressed' | 'active';

export interface GraphNode {
  id: number;
  isHeroFirm: boolean;
  hub: HubName;
  hubId: number; // 0=NYC,1=London,2=Tokyo,3=HongKong,4=Dubai
  firmName: string;
  cityName: string;
  lat: number;
  lon: number;
  riskScore: number;       // 0–1
  nav: number;             // USD
  exposureTotal: number;   // USD
  totalAssets: number;     // USD
  liabilities: number;     // USD
  isDefaulted: boolean;
  cascadeDepth: number;    // BFS depth in active cascade
  state: NodeState;
  portfolio: {
    equities: number;
    realEstate: number;
    crypto: number;
    treasuries: number;
    corpBonds: number;
  };
}

export interface GraphEdge {
  debtorId: number;
  creditorId: number;
  amount: number;
  state: EdgeState;
}

export interface AdjacencyIndex {
  // outgoing neighbors for node i
  neighbors: Map<number, number[]>;
  // edge lookup by debtorId+creditorId key
  edgeMap: Map<string, GraphEdge>;
}

export function getNodeState(riskScore: number, isDefaulted: boolean): NodeState {
  if (isDefaulted) return 'defaulted';
  if (riskScore >= 0.85) return 'defaulted';
  if (riskScore >= 0.6) return 'critical';
  if (riskScore >= 0.3) return 'stressed';
  return 'idle';
}

export function nodeStateColor(state: NodeState, isHero: boolean): [number, number, number, number] {
  if (isHero) return [168, 85, 247, 255];
  switch (state) {
    case 'defaulted': return [255, 32, 32, 255];
    case 'critical':  return [255, 80, 0, 255];
    case 'stressed':  return [255, 140, 0, 255];
    case 'idle':      return [192, 255, 255, 255];
  }
}

export function nodeRadius(nav: number): number {
  return Math.max(5, Math.min(24, Math.log10(Math.max(nav, 1e6)) * 7 - 35));
}
