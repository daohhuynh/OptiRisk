import { TextLayer } from '@deck.gl/layers';
import type { CityHub, HubAggregate } from '@/lib/graph/cityHubs';

// Hub blobs are positioned at gateway-city centers (NYC, London, ...). When
// labelled at the region zoom we want the broad region name instead so the
// label reads "EUROPE" not "London".
const HUB_TO_REGION: Record<string, string> = {
  NYC: 'AMERICAS',
  London: 'EUROPE',
  Tokyo: 'EAST ASIA',
  HongKong: 'SOUTHEAST ASIA',
  Dubai: 'MIDDLE EAST',
};

type BlobLabelDatum =
  | { kind: 'city'; name: string; lat: number; lon: number; count: number }
  | { kind: 'hub'; name: string; lat: number; lon: number };

interface CityLabelOptions {
  kind: 'city';
  items: CityHub[];
  anchorName: string | null;
  hoveredName: string | null;
  neighbors: Set<string>;
}

interface HubLabelOptions {
  kind: 'hub';
  items: HubAggregate[];
  anchorName: string | null;
  hoveredName: string | null;
  neighbors: Set<string>;
}

type BlobLabelOptions = CityLabelOptions | HubLabelOptions;

// Same cyan family as the firm label layer so the visual hierarchy reads the
// same across all three zoom levels: anchor pops, neighbours stay legible,
// idle is muted, dimmed elements fade back into the basemap.
const COLOR_ANCHOR:   [number, number, number, number] = [0,   229, 255, 255];
const COLOR_NEIGHBOR: [number, number, number, number] = [150, 220, 240, 230];
const COLOR_IDLE:     [number, number, number, number] = [120, 170, 200, 200];
const COLOR_DIMMED:   [number, number, number, number] = [80,  110, 135, 110];

export function buildBlobLabelLayer(opts: BlobLabelOptions): TextLayer<BlobLabelDatum> {
  const { kind, anchorName, hoveredName, neighbors } = opts;
  const focusActive = anchorName !== null || hoveredName !== null;

  // Hubs are few (≤5) and their region names are part of the basemap reading,
  // so we keep them always-on. Cities mimic the firm label rule: only the
  // focus anchor and its first-degree neighbours are labelled, so the map
  // stays clean when nothing is selected.
  const data: BlobLabelDatum[] = kind === 'city'
    ? opts.items
        .filter((c) =>
          c.cityName === anchorName ||
          c.cityName === hoveredName ||
          neighbors.has(c.cityName),
        )
        .map((c) => ({
          kind: 'city' as const,
          name: c.cityName,
          lat: c.lat,
          lon: c.lon,
          count: c.nodeCount,
        }))
    : opts.items.map((h) => ({
        kind: 'hub' as const,
        name: h.hubName,
        lat: h.lat,
        lon: h.lon,
      }));

  const tier = (name: string) => {
    if (name === anchorName || name === hoveredName) return 'anchor' as const;
    if (neighbors.has(name)) return 'neighbor' as const;
    if (focusActive) return 'dimmed' as const;
    return 'idle' as const;
  };

  return new TextLayer<BlobLabelDatum>({
    id: kind === 'city' ? 'blob-labels-city' : 'blob-labels-hub',
    data,
    pickable: false,

    getPosition: (d) => [d.lon, d.lat],

    getText: (d) => {
      if (d.kind === 'city') return `${d.name.toUpperCase()} · ${d.count}`;
      return HUB_TO_REGION[d.name] ?? d.name.toUpperCase();
    },

    getSize: (d) => {
      const t = tier(d.name);
      if (t === 'anchor') return 13;
      if (t === 'neighbor') return 12;
      if (t === 'idle') return 11;
      return 10;
    },

    getColor: (d) => {
      const t = tier(d.name);
      if (t === 'anchor') return COLOR_ANCHOR;
      if (t === 'neighbor') return COLOR_NEIGHBOR;
      if (t === 'idle') return COLOR_IDLE;
      return COLOR_DIMMED;
    },

    // City labels sit just above the blob; hub labels are huge enough that
    // centring inside the glow reads cleanest.
    getPixelOffset: kind === 'city' ? [0, -14] : [0, 0],
    getTextAnchor: 'middle',
    getAlignmentBaseline: kind === 'city' ? 'bottom' : 'center',

    fontFamily: 'JetBrains Mono, monospace',
    fontWeight: '500',
    background: false,
    sizeUnits: 'pixels',

    // Always paint above blobs/arcs in the 3D pipeline (luma.gl v9 syntax;
    // replaces the legacy `depthTest: false` flag).
    parameters: { depthCompare: 'always' },

    updateTriggers: {
      getText: [anchorName, hoveredName, neighbors],
      getSize: [anchorName, hoveredName, neighbors],
      getColor: [anchorName, hoveredName, neighbors],
    },
  });
}
