import { TextLayer } from '@deck.gl/layers';
import type { GraphNode } from '@/types/graph';

interface GeoLabel {
  label: string;
  lat: number;
  lon: number;
}

// Five broad region anchors — shown only at low zoom
const HUB_REGION_LABELS: GeoLabel[] = [
  { label: 'AMERICAS',        lat: 40,  lon: -95  },
  { label: 'EUROPE',          lat: 51,  lon:   8  },
  { label: 'EAST ASIA',       lat: 37,  lon: 135  },
  { label: 'SOUTHEAST ASIA',  lat: 12,  lon: 108  },
  { label: 'MIDDLE EAST',     lat: 28,  lon:  48  },
];

// Derive one label per unique city that has at least one node, positioned at centroid
function cityLabels(nodes: GraphNode[]): GeoLabel[] {
  const acc = new Map<string, { sumLat: number; sumLon: number; count: number }>();
  for (const n of nodes) {
    const e = acc.get(n.cityName) ?? { sumLat: 0, sumLon: 0, count: 0 };
    e.sumLat += n.lat;
    e.sumLon += n.lon;
    e.count++;
    acc.set(n.cityName, e);
  }
  return Array.from(acc.entries()).map(([name, { sumLat, sumLon, count }]) => ({
    label: name,
    lat: sumLat / count,
    lon: sumLon / count,
  }));
}

export function buildGeoLabelsLayer(
  nodes: GraphNode[],
  zoom: number,
): TextLayer<GeoLabel> | null {
  // < 3.2 → broad region names
  if (zoom < 3.2) {
    const alpha = Math.round(Math.max(0, Math.min(1, (3.2 - zoom) / 0.8)) * 70);
    return new TextLayer<GeoLabel>({
      id: 'geo-regions',
      data: HUB_REGION_LABELS,
      pickable: false,
      getPosition: (d) => [d.lon, d.lat],
      getText: (d) => d.label,
      getSize: 10,
      getColor: [120, 160, 190, alpha],
      fontFamily: 'Inter, sans-serif',
      fontWeight: '600',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'center',
      sizeUnits: 'pixels',
      parameters: { depthCompare: 'always' },
      updateTriggers: { getColor: [zoom] },
    });
  }

  // 3.2–5 → city cluster names (only cities with nodes)
  if (zoom < 5) {
    const alpha = Math.round(Math.min(1, (zoom - 3.2) / 0.8) * 90);
    return new TextLayer<GeoLabel>({
      id: 'geo-cities',
      data: cityLabels(nodes),
      pickable: false,
      getPosition: (d) => [d.lon, d.lat],
      getText: (d) => d.label,
      getSize: 9,
      getColor: [100, 145, 175, alpha],
      fontFamily: 'Inter, sans-serif',
      fontWeight: '500',
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      getPixelOffset: [0, -12],
      sizeUnits: 'pixels',
      parameters: { depthCompare: 'always' },
      updateTriggers: { getColor: [zoom] },
    });
  }

  return null;
}
