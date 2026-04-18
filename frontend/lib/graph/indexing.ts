import type { GraphEdge, GraphNode } from '@/types/graph';

// Build adjacency index for O(1) neighbor lookup
export function buildAdjacencyIndex(edges: GraphEdge[]): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const edge of edges) {
    const neighbors = adj.get(edge.debtorId) ?? [];
    neighbors.push(edge.creditorId);
    adj.set(edge.debtorId, neighbors);
    const revNeighbors = adj.get(edge.creditorId) ?? [];
    revNeighbors.push(edge.debtorId);
    adj.set(edge.creditorId, revNeighbors);
  }
  return adj;
}

// Get 1-hop neighborhood for a node
export function getNeighborhood(nodeId: number, adj: Map<number, number[]>): number[] {
  return adj.get(nodeId) ?? [];
}

// Tiered city placement. Each hub is a list of real financial cities with a
// relative weight (share of hub nodes) and a jitter radius (tight local cluster
// around the city center). Coastal city centers are nudged slightly inland so
// the jitter disc stays on land without needing a polygon water mask.
interface HubCity {
  name: string;
  lat: number;
  lon: number;
  weight: number;
  jitterRadiusDeg: number;
}

const HUB_CITIES: Record<string, HubCity[]> = {
  NYC: [
    { name: 'New York',       lat: 40.75,  lon: -74.00,  weight: 40, jitterRadiusDeg: 0.50 },
    { name: 'Boston',         lat: 42.36,  lon: -71.15,  weight: 10, jitterRadiusDeg: 0.60 },
    { name: 'Toronto',        lat: 43.70,  lon: -79.40,  weight: 8,  jitterRadiusDeg: 0.65 },
    { name: 'Chicago',        lat: 41.88,  lon: -87.63,  weight: 8,  jitterRadiusDeg: 0.65 },
    { name: 'Washington DC',  lat: 38.90,  lon: -77.04,  weight: 5,  jitterRadiusDeg: 0.50 },
    { name: 'Philadelphia',   lat: 39.95,  lon: -75.17,  weight: 4,  jitterRadiusDeg: 0.45 },
    { name: 'Montreal',       lat: 45.50,  lon: -73.57,  weight: 4,  jitterRadiusDeg: 0.50 },
    { name: 'Atlanta',        lat: 33.75,  lon: -84.39,  weight: 3,  jitterRadiusDeg: 0.50 },
    { name: 'Charlotte',      lat: 35.23,  lon: -80.84,  weight: 3,  jitterRadiusDeg: 0.45 },
    { name: 'Miami',          lat: 25.85,  lon: -80.30,  weight: 3,  jitterRadiusDeg: 0.40 },
    { name: 'San Francisco',  lat: 37.75,  lon: -122.20, weight: 4,  jitterRadiusDeg: 0.45 },
    { name: 'Los Angeles',    lat: 34.05,  lon: -118.20, weight: 4,  jitterRadiusDeg: 0.50 },
    { name: 'Seattle',        lat: 47.60,  lon: -122.20, weight: 3,  jitterRadiusDeg: 0.45 },
    { name: 'Dallas',         lat: 32.78,  lon: -96.80,  weight: 2,  jitterRadiusDeg: 0.50 },
    { name: 'Denver',         lat: 39.74,  lon: -104.99, weight: 2,  jitterRadiusDeg: 0.50 },
  ],
  London: [
    { name: 'London',         lat: 51.51,  lon: -0.13,   weight: 35, jitterRadiusDeg: 0.50 },
    { name: 'Paris',          lat: 48.86,  lon: 2.35,    weight: 10, jitterRadiusDeg: 0.60 },
    { name: 'Frankfurt',      lat: 50.11,  lon: 8.68,    weight: 9,  jitterRadiusDeg: 0.60 },
    { name: 'Zurich',         lat: 47.38,  lon: 8.54,    weight: 6,  jitterRadiusDeg: 0.50 },
    { name: 'Amsterdam',      lat: 52.37,  lon: 4.90,    weight: 6,  jitterRadiusDeg: 0.45 },
    { name: 'Milan',          lat: 45.46,  lon: 9.19,    weight: 5,  jitterRadiusDeg: 0.50 },
    { name: 'Madrid',         lat: 40.42,  lon: -3.70,   weight: 4,  jitterRadiusDeg: 0.50 },
    { name: 'Dublin',         lat: 53.35,  lon: -6.26,   weight: 4,  jitterRadiusDeg: 0.40 },
    { name: 'Stockholm',      lat: 59.33,  lon: 18.00,   weight: 3,  jitterRadiusDeg: 0.45 },
    { name: 'Brussels',       lat: 50.85,  lon: 4.35,    weight: 3,  jitterRadiusDeg: 0.40 },
    { name: 'Luxembourg',     lat: 49.61,  lon: 6.13,    weight: 3,  jitterRadiusDeg: 0.35 },
    { name: 'Copenhagen',     lat: 55.68,  lon: 12.50,   weight: 2,  jitterRadiusDeg: 0.40 },
    { name: 'Oslo',           lat: 59.91,  lon: 10.75,   weight: 2,  jitterRadiusDeg: 0.40 },
    { name: 'Vienna',         lat: 48.21,  lon: 16.37,   weight: 2,  jitterRadiusDeg: 0.40 },
    { name: 'Warsaw',         lat: 52.23,  lon: 21.01,   weight: 2,  jitterRadiusDeg: 0.50 },
    { name: 'Lisbon',         lat: 38.75,  lon: -9.10,   weight: 2,  jitterRadiusDeg: 0.35 },
    { name: 'Helsinki',       lat: 60.20,  lon: 24.80,   weight: 2,  jitterRadiusDeg: 0.35 },
  ],
  Tokyo: [
    { name: 'Tokyo',          lat: 35.70,  lon: 139.72,  weight: 40, jitterRadiusDeg: 0.50 },
    { name: 'Osaka',          lat: 34.69,  lon: 135.50,  weight: 12, jitterRadiusDeg: 0.50 },
    { name: 'Seoul',          lat: 37.57,  lon: 126.98,  weight: 12, jitterRadiusDeg: 0.50 },
    { name: 'Nagoya',         lat: 35.18,  lon: 136.90,  weight: 6,  jitterRadiusDeg: 0.40 },
    { name: 'Fukuoka',        lat: 33.59,  lon: 130.45,  weight: 5,  jitterRadiusDeg: 0.35 },
    { name: 'Kyoto',          lat: 35.01,  lon: 135.77,  weight: 4,  jitterRadiusDeg: 0.35 },
    { name: 'Sapporo',        lat: 43.06,  lon: 141.35,  weight: 3,  jitterRadiusDeg: 0.45 },
    { name: 'Busan',          lat: 35.15,  lon: 129.00,  weight: 4,  jitterRadiusDeg: 0.35 },
    { name: 'Taipei',         lat: 25.03,  lon: 121.57,  weight: 4,  jitterRadiusDeg: 0.35 },
  ],
  HongKong: [
    { name: 'Hong Kong',      lat: 22.40,  lon: 114.13,  weight: 30, jitterRadiusDeg: 0.35 },
    { name: 'Singapore',      lat: 1.35,   lon: 103.82,  weight: 15, jitterRadiusDeg: 0.22 },
    { name: 'Shanghai',       lat: 31.23,  lon: 121.47,  weight: 12, jitterRadiusDeg: 0.50 },
    { name: 'Shenzhen',       lat: 22.60,  lon: 114.05,  weight: 8,  jitterRadiusDeg: 0.28 },
    { name: 'Taipei',         lat: 25.03,  lon: 121.57,  weight: 5,  jitterRadiusDeg: 0.35 },
    { name: 'Bangkok',        lat: 13.75,  lon: 100.52,  weight: 5,  jitterRadiusDeg: 0.50 },
    { name: 'Kuala Lumpur',   lat: 3.14,   lon: 101.69,  weight: 5,  jitterRadiusDeg: 0.40 },
    { name: 'Jakarta',        lat: -6.21,  lon: 106.85,  weight: 5,  jitterRadiusDeg: 0.35 },
    { name: 'Manila',         lat: 14.60,  lon: 120.98,  weight: 4,  jitterRadiusDeg: 0.35 },
    { name: 'Ho Chi Minh City', lat: 10.82, lon: 106.62, weight: 6,  jitterRadiusDeg: 0.40 },
    { name: 'Guangzhou',      lat: 23.13,  lon: 113.26,  weight: 3,  jitterRadiusDeg: 0.40 },
  ],
  Dubai: [
    { name: 'Dubai',          lat: 25.20,  lon: 55.27,   weight: 35, jitterRadiusDeg: 0.42 },
    { name: 'Abu Dhabi',      lat: 24.47,  lon: 54.40,   weight: 12, jitterRadiusDeg: 0.40 },
    { name: 'Riyadh',         lat: 24.71,  lon: 46.67,   weight: 10, jitterRadiusDeg: 0.60 },
    { name: 'Doha',           lat: 25.29,  lon: 51.53,   weight: 8,  jitterRadiusDeg: 0.35 },
    { name: 'Manama',         lat: 26.23,  lon: 50.58,   weight: 5,  jitterRadiusDeg: 0.28 },
    { name: 'Kuwait City',    lat: 29.38,  lon: 47.99,   weight: 5,  jitterRadiusDeg: 0.35 },
    { name: 'Muscat',         lat: 23.59,  lon: 58.41,   weight: 4,  jitterRadiusDeg: 0.35 },
    { name: 'Tel Aviv',       lat: 32.09,  lon: 34.82,   weight: 4,  jitterRadiusDeg: 0.35 },
    { name: 'Istanbul',       lat: 41.01,  lon: 28.98,   weight: 5,  jitterRadiusDeg: 0.45 },
    { name: 'Cairo',          lat: 30.04,  lon: 31.24,   weight: 4,  jitterRadiusDeg: 0.50 },
    { name: 'Amman',          lat: 31.95,  lon: 35.93,   weight: 3,  jitterRadiusDeg: 0.40 },
    { name: 'Beirut',         lat: 33.89,  lon: 35.51,   weight: 3,  jitterRadiusDeg: 0.35 },
  ],
};

const GOLDEN_ANGLE = 2.39996; // radians — produces even sunflower spiral

// Largest-remainder (Hamilton) apportionment: deterministically divides
// totalInHub across cities in proportion to weights, summing exactly to totalInHub.
function apportionCounts(cities: HubCity[], totalInHub: number): number[] {
  const totalWeight = cities.reduce((s, c) => s + c.weight, 0);
  if (totalWeight <= 0 || totalInHub <= 0) return cities.map(() => 0);

  const raw = cities.map((c) => (c.weight / totalWeight) * totalInHub);
  const counts = raw.map((x) => Math.floor(x));
  let remaining = totalInHub - counts.reduce((a, b) => a + b, 0);

  // Distribute the leftover to cities with the largest fractional remainders.
  // Tie-breaker: higher weight first, then lower index — deterministic.
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x), w: cities[i].weight }))
    .sort((a, b) => b.frac - a.frac || b.w - a.w || a.i - b.i);

  for (let k = 0; k < order.length && remaining > 0; k++) {
    counts[order[k].i] += 1;
    remaining -= 1;
  }
  return counts;
}

// Memoize per (hub, totalInHub) so we compute apportionment once per hub.
const cityCountsCache = new Map<string, number[]>();
function getCityCounts(hub: string, cities: HubCity[], totalInHub: number): number[] {
  const key = `${hub}:${totalInHub}`;
  const cached = cityCountsCache.get(key);
  if (cached) return cached;
  const counts = apportionCounts(cities, totalInHub);
  cityCountsCache.set(key, counts);
  return counts;
}

// Map a node's indexInHub to a specific city and its local index within that city.
function assignCity(
  hub: string,
  cities: HubCity[],
  indexInHub: number,
  totalInHub: number,
): { city: HubCity; indexInCity: number; totalInCity: number } {
  const counts = getCityCounts(hub, cities, totalInHub);
  let cum = 0;
  for (let i = 0; i < cities.length; i++) {
    const n = counts[i];
    if (n > 0 && indexInHub < cum + n) {
      return { city: cities[i], indexInCity: indexInHub - cum, totalInCity: n };
    }
    cum += n;
  }
  // Fallback — shouldn't happen because counts sum to totalInHub.
  const fallback = cities[0];
  return { city: fallback, indexInCity: 0, totalInCity: 1 };
}

// Golden-angle sunflower spiral inscribed in a circular disc of given radius.
// Returns [dLat, dLon] offsets from the disc center.
function spiralInDisc(
  indexInCity: number,
  totalInCity: number,
  radiusDeg: number,
): [number, number] {
  const total = Math.max(1, totalInCity);
  const theta = indexInCity * GOLDEN_ANGLE;
  const r = Math.sqrt((indexInCity + 0.5) / total);
  return [r * Math.cos(theta) * radiusDeg, r * Math.sin(theta) * radiusDeg];
}

// Derive geo coordinates and city name. Deterministic, no RNG.
function hubCoordinates(hub: string, indexInHub: number, totalInHub: number): { lat: number; lon: number; cityName: string } {
  const cities = HUB_CITIES[hub] ?? HUB_CITIES['NYC'];
  const { city, indexInCity, totalInCity } = assignCity(hub, cities, indexInHub, totalInHub);
  const [dLat, dLon] = spiralInDisc(indexInCity, totalInCity, city.jitterRadiusDeg);
  return { lat: city.lat + dLat, lon: city.lon + dLon, cityName: city.name };
}

// Convert JSON snapshot format to GraphNode[] and GraphEdge[]
export function parseInitialSnapshot(json: {
  nodes: Array<{
    id: number;
    name?: string;
    is_hero_firm: boolean;
    hub: string;
    location: { lat: number; lon: number };
    portfolio: {
      Equities: number;
      Real_Estate: number;
      Crypto: number;
      Treasuries: number;
      Corp_Bonds: number;
    };
    total_assets: number;
    liabilities: number;
    nav: number;
  }>;
  edges: Array<{ debtor_id: number; creditor_id: number; amount: number }>;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const HUB_IDS: Record<string, number> = {
    NYC: 0, London: 1, Tokyo: 2, HongKong: 3, 'Hong Kong': 3, Dubai: 4,
  };
  const hubNames = ['NYC', 'London', 'Tokyo', 'HongKong', 'Dubai'] as const;

  // Count nodes per hub first so spiral radius can be normalised
  const hubTotals = new Map<string, number>();
  for (const n of json.nodes) {
    const key = n.hub in HUB_CITIES ? n.hub : 'NYC';
    hubTotals.set(key, (hubTotals.get(key) ?? 0) + 1);
  }

  // Per-hub counter for the spiral index
  const hubCounters = new Map<string, number>();

  const nodes: GraphNode[] = json.nodes.map((n) => {
    const hubKey  = n.hub in HUB_CITIES ? n.hub : 'NYC';
    const hubId   = HUB_IDS[n.hub] ?? 0;
    const idx     = hubCounters.get(hubKey) ?? 0;
    hubCounters.set(hubKey, idx + 1);
    const total   = hubTotals.get(hubKey) ?? 1;

    const { lat, lon, cityName } = hubCoordinates(hubKey, idx, total);

    return {
      id: n.id,
      firmName: n.name ?? `Node ${n.id}`,
      isHeroFirm: n.is_hero_firm,
      hub: hubNames[hubId],
      hubId,
      cityName,
      lat,
      lon,
      riskScore: 0.1,
      nav: n.nav,
      exposureTotal: n.total_assets,
      totalAssets: n.total_assets,
      liabilities: n.liabilities,
      isDefaulted: false,
      cascadeDepth: 0,
      state: 'idle' as const,
      portfolio: {
        equities:   n.portfolio.Equities,
        realEstate: n.portfolio.Real_Estate,
        crypto:     n.portfolio.Crypto,
        treasuries: n.portfolio.Treasuries,
        corpBonds:  n.portfolio.Corp_Bonds,
      },
    };
  });

  const edges: GraphEdge[] = json.edges.map((e) => ({
    debtorId:   e.debtor_id,
    creditorId: e.creditor_id,
    amount:     e.amount,
    state:      'idle' as const,
  }));

  return { nodes, edges };
}
