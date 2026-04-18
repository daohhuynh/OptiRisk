import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { HubAggregate } from '@/lib/graph/cityHubs';
import { nodeStateColor } from '@/types/graph';

interface CityHubLayerOptions {
  hubs: HubAggregate[];
  selectedHubName: string | null;
  hoveredHubName: string | null;
  // Hub names directly connected to the focus anchor via hubEdges. Kept lit
  // so arc endpoints don't terminate against a dimmed dot.
  neighborHubs?: Set<string>;
  onSelect: (hub: HubAggregate | null) => void;
  onHover: (name: string | null) => void;
  opacity?: number;
}

const DIM_RGB: [number, number, number] = [70, 90, 110];

export function buildCityHubLayers(opts: CityHubLayerOptions): Layer[] {
  const { hubs, selectedHubName, hoveredHubName, neighborHubs, onSelect, onHover, opacity = 1 } = opts;

  const neighbors = neighborHubs ?? new Set<string>();
  const focusActive = hoveredHubName !== null || selectedHubName !== null;
  const isHov  = (h: HubAggregate) => h.hubName === hoveredHubName;
  const isSel  = (h: HubAggregate) => h.hubName === selectedHubName;
  const isAnchor   = (h: HubAggregate) => isHov(h) || isSel(h);
  const isNeighbor = (h: HubAggregate) => !isAnchor(h) && neighbors.has(h.hubName);
  const isLit  = (h: HubAggregate) => isAnchor(h) || isNeighbor(h);
  const isDim  = (h: HubAggregate) => focusActive && !isLit(h);

  const triggers = {
    getRadius:    [hoveredHubName, selectedHubName, neighbors],
    getFillColor: [hoveredHubName, selectedHubName, neighbors],
    getLineWidth: [hoveredHubName, selectedHubName, neighbors],
  };

  const transitions = { getRadius: 200, getFillColor: 200, getLineWidth: 200 };

  const outerGlow = new ScatterplotLayer<HubAggregate>({
    id: 'hub-outer-glow',
    data: hubs,
    pickable: false,
    stroked: false,
    filled: true,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 0,
    radiusMaxPixels: 120,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 0;
      if (isSel(h)) return 110;
      if (isHov(h)) return 96;
      if (isNeighbor(h)) return 88;
      return 80;
    },
    getFillColor: (h) => {
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 0];
      const [r, g, b] = nodeStateColor(h.worstState, false);
      return [r, g, b, isSel(h) ? 18 : isHov(h) ? 15 : isNeighbor(h) ? 12 : 10];
    },
    updateTriggers: triggers,
    transitions,
  });

  const midGlow = new ScatterplotLayer<HubAggregate>({
    id: 'hub-mid-glow',
    data: hubs,
    pickable: false,
    stroked: false,
    filled: true,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 0,
    radiusMaxPixels: 70,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 0;
      if (isSel(h)) return 65;
      if (isHov(h)) return 56;
      if (isNeighbor(h)) return 52;
      return 46;
    },
    getFillColor: (h) => {
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 0];
      const [r, g, b] = nodeStateColor(h.worstState, false);
      return [r, g, b, isSel(h) ? 35 : isHov(h) ? 30 : isNeighbor(h) ? 26 : 22];
    },
    updateTriggers: triggers,
    transitions,
  });

  const core = new ScatterplotLayer<HubAggregate>({
    id: 'hub-core',
    data: hubs,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 0,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 6,
    radiusMaxPixels: 30,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 5;
      if (isSel(h)) return 14;
      if (isHov(h)) return 10;
      if (isNeighbor(h)) return 13;
      return 14;
    },
    getFillColor: (h) => {
      const [r, g, b] = nodeStateColor(h.worstState, false);
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 22];
      if (isSel(h) || isHov(h)) return [r, g, b, 255];
      if (isNeighbor(h)) return [r, g, b, 230];
      return [r, g, b, 200];
    },
    getLineColor: [0, 229, 255, 100],
    getLineWidth: (h) => (isSel(h) || isHov(h)) ? 1.5 : isNeighbor(h) ? 0.8 : 0,
    onHover: (info) => onHover(info.object ? info.object.hubName : null),
    onClick: (info) => onSelect(info.object ?? null),
    updateTriggers: triggers,
    transitions,
  });

  return [outerGlow, midGlow, core];
}
