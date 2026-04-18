import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { CityHub } from '@/lib/graph/cityHubs';
import { nodeStateColor } from '@/types/graph';

interface CityBlobLayerOptions {
  hubs: CityHub[];
  selectedCityName: string | null;
  hoveredCityName: string | null;
  // City names directly connected to the focus anchor via cityEdges. These
  // blobs are kept lit (just less than the anchor) so the arc endpoints are
  // never drawn against a dimmed dot.
  neighborCities?: Set<string>;
  onSelect: (hub: CityHub | null) => void;
  onHover: (name: string | null) => void;
  opacity?: number;
}

const DIM_RGB: [number, number, number] = [70, 90, 110];

export function buildCityBlobLayers(opts: CityBlobLayerOptions): Layer[] {
  const { hubs, selectedCityName, hoveredCityName, neighborCities, onSelect, onHover, opacity = 1 } = opts;

  const neighbors = neighborCities ?? new Set<string>();
  const focusActive = hoveredCityName !== null || selectedCityName !== null;
  const isHov  = (h: CityHub) => h.cityName === hoveredCityName;
  const isSel  = (h: CityHub) => h.cityName === selectedCityName;
  const isAnchor   = (h: CityHub) => isHov(h) || isSel(h);
  const isNeighbor = (h: CityHub) => !isAnchor(h) && neighbors.has(h.cityName);
  const isLit  = (h: CityHub) => isAnchor(h) || isNeighbor(h);
  const isDim  = (h: CityHub) => focusActive && !isLit(h);

  const triggers = {
    getRadius:    [hoveredCityName, selectedCityName, neighbors],
    getFillColor: [hoveredCityName, selectedCityName, neighbors],
    getLineWidth: [hoveredCityName, selectedCityName, neighbors],
  };

  const transitions = { getRadius: 150, getFillColor: 150, getLineWidth: 150 };

  const outerGlow = new ScatterplotLayer<CityHub>({
    id: 'city-blob-outer',
    data: hubs,
    pickable: false,
    stroked: false,
    filled: true,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 0,
    radiusMaxPixels: 60,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 46;
      if (isSel(h)) return 52;
      if (isHov(h)) return 46;
      if (isNeighbor(h)) return 40;
      return 36;
    },
    getFillColor: (h) => {
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 6];
      const [r, g, b] = nodeStateColor(h.worstState, false);
      return [r, g, b, isSel(h) ? 22 : isHov(h) ? 18 : isNeighbor(h) ? 14 : 11];
    },
    updateTriggers: triggers,
    transitions,
  });

  const midGlow = new ScatterplotLayer<CityHub>({
    id: 'city-blob-mid',
    data: hubs,
    pickable: false,
    stroked: false,
    filled: true,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 0,
    radiusMaxPixels: 32,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 0;
      if (isSel(h)) return 30;
      if (isHov(h)) return 26;
      if (isNeighbor(h)) return 23;
      return 19;
    },
    getFillColor: (h) => {
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 0];
      const [r, g, b] = nodeStateColor(h.worstState, false);
      return [r, g, b, isSel(h) ? 42 : isHov(h) ? 36 : isNeighbor(h) ? 30 : 25];
    },
    updateTriggers: triggers,
    transitions,
  });

  const core = new ScatterplotLayer<CityHub>({
    id: 'city-blob-core',
    data: hubs,
    pickable: true,
    stroked: true,
    filled: true,
    lineWidthUnits: 'pixels',
    lineWidthMinPixels: 0,
    opacity,
    radiusUnits: 'pixels',
    radiusMinPixels: 3,
    radiusMaxPixels: 16,
    getPosition: (h) => [h.lon, h.lat],
    getRadius: (h) => {
      if (isDim(h)) return 3;
      if (isSel(h)) return 12;
      if (isHov(h)) return 10;
      if (isNeighbor(h)) return 9;
      return 7;
    },
    getFillColor: (h) => {
      const [r, g, b] = nodeStateColor(h.worstState, false);
      if (isDim(h)) return [DIM_RGB[0], DIM_RGB[1], DIM_RGB[2], 22];
      if (isSel(h) || isHov(h)) return [r, g, b, 255];
      if (isNeighbor(h)) return [r, g, b, 230];
      return [r, g, b, 200];
    },
    getLineColor: [0, 229, 255, 90],
    getLineWidth: (h) => (isSel(h) || isHov(h)) ? 1.5 : isNeighbor(h) ? 0.8 : 0,
    onHover: (info) => onHover(info.object ? info.object.cityName : null),
    onClick: (info) => onSelect(info.object ?? null),
    updateTriggers: triggers,
    transitions,
  });

  return [outerGlow, midGlow, core];
}
