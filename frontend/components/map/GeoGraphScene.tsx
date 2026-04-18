'use client';

import { useMemo, useCallback, useState, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { MapView } from '@deck.gl/core';
import { Map } from 'react-map-gl/maplibre';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useGraphStore } from '@/store/graphStore';
import { useUIStore } from '@/store/uiStore';
import { useSimulationStore } from '@/store/simulationStore';
import { buildAdjacencyIndex, getNeighborhood } from '@/lib/graph/indexing';
import { buildNodeLayers } from './layers/nodeLayer';
import { buildEdgeLayers, buildStableEdgeData } from './layers/edgeLayer';
import { buildLabelLayer } from './layers/labelLayer';
import { useFormationAnimation } from '@/hooks/useFormationAnimation';
import { buildBlobLabelLayer } from './layers/blobLabelLayer';
import { buildCityHubLayers } from './layers/cityHubLayer';
import { buildHubEdgeLayer } from './layers/hubEdgeLayer';
import { buildCityBlobLayers } from './layers/cityBlobLayer';
import { buildCityEdgeLayer } from './layers/cityEdgeLayer';
import { buildFocusEdgeLayer } from './layers/focusEdgeLayer';
import { buildEdgeIndex, deriveFocusEdges } from '@/lib/graph/focusEdges';
import { deriveHubAggregates, deriveHubEdges, deriveCityHubs, deriveCityEdges } from '@/lib/graph/cityHubs';
import type { HubAggregate, CityHub } from '@/lib/graph/cityHubs';
import type { GraphNode } from '@/types/graph';

// Raster-only style — solid dark land, no borders, no labels (labels handled by deck.gl)
const MAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    'carto-nolabels': {
      type: 'raster' as const,
      tiles: ['https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}@2x.png'],
      tileSize: 512,
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'raster-bg',
      type: 'raster' as const,
      source: 'carto-nolabels',
    },
  ],
};

const MIN_ZOOM = 1.2;
const MAX_ZOOM = 12;
const MAX_PITCH = 60;

// minZoom / maxZoom / minPitch / maxPitch are read by deck.gl's controller in
// uncontrolled mode, so the camera self-clamps without a React round-trip.
const INITIAL_VIEW = {
  longitude: 20,
  latitude: 25,
  zoom: 2.8,
  pitch: 35,
  bearing: 0,
  minZoom: MIN_ZOOM,
  maxZoom: MAX_ZOOM,
  minPitch: 0,
  maxPitch: MAX_PITCH,
};

type ViewState = typeof INITIAL_VIEW;

const MAIN_VIEW = new MapView({
  id: 'main',
  repeat: false,
  controller: {
    dragRotate: true,
    touchRotate: true,
    scrollZoom: { speed: 0.01, smooth: true },
  },
});

// Bucket continuous zoom into 0.1-wide steps. The label layers only care about
// zoom-thresholded visibility / fades; rounding here means a smooth drag/zoom
// fires `setZoomBucket` ~10x less often, and React bails out entirely when the
// bucketed value is unchanged (no re-render → no layer rebuild).
const ZOOM_BUCKET_STEP = 0.1;
const bucketizeZoom = (z: number) =>
  Math.round(z / ZOOM_BUCKET_STEP) * ZOOM_BUCKET_STEP;

export default function GeoGraphScene() {
  // Granular selectors — each field is its own subscription
  const nodes              = useGraphStore(s => s.nodes);
  const edges              = useGraphStore(s => s.edges);
  const defaultedNodeIds   = useGraphStore(s => s.defaultedNodeIds);
  const hoveredNodeId      = useUIStore(s => s.hoveredNodeId);
  const hoveredNeighborIds = useUIStore(s => s.hoveredNeighborIds);
  const selectedNodeId     = useUIStore(s => s.selectedNodeId);
  const highlightedIds     = useUIStore(s => s.highlightedNeighborIds);
  const setHoveredNode     = useUIStore(s => s.setHoveredNode);
  const setSelectedNode    = useUIStore(s => s.setSelectedNode);
  const clearSelection     = useUIStore(s => s.clearSelection);
  const selectedCityName   = useUIStore(s => s.selectedCityName);
  const setSelectedCity    = useUIStore(s => s.setSelectedCity);
  const hoveredCityName    = useUIStore(s => s.hoveredCityName);
  const setHoveredCity     = useUIStore(s => s.setHoveredCity);
  const phase              = useSimulationStore(s => s.phase);

  // Only the bucketed zoom is tracked in React state. Camera (lon/lat/pitch/
  // bearing/exact zoom) lives entirely inside deck.gl in uncontrolled mode.
  const [zoomBucket, setZoomBucket] = useState(() => bucketizeZoom(INITIAL_VIEW.zoom));

  const nodeList     = useMemo(() => Array.from(nodes.values()), [nodes]);
  const adjacency    = useMemo(() => buildAdjacencyIndex(edges), [edges]);
  const edgeIndex    = useMemo(() => buildEdgeIndex(edges), [edges]);
  const hubAggregates = useMemo(() => deriveHubAggregates(nodeList), [nodeList]);
  const hubEdges      = useMemo(() => deriveHubEdges(nodeList, edges), [nodeList, edges]);
  const cityHubs      = useMemo(() => deriveCityHubs(nodeList), [nodeList]);
  const cityEdges     = useMemo(() => deriveCityEdges(nodeList, edges), [nodeList, edges]);

  // Three zoom levels — company is the default/initial view; city and region
  // appear only when the user explicitly zooms out past these thresholds.
  const ZOOM_CITY    = 2.0;
  const ZOOM_COMPANY = 2.5;
  const regionMode = zoomBucket < ZOOM_CITY;
  const cityMode   = zoomBucket >= ZOOM_CITY && zoomBucket < ZOOM_COMPANY;
  const zoomLevel  = regionMode ? 'region' : cityMode ? 'city' : 'company';

  // Clear hover when crossing a zoom level boundary
  useEffect(() => { setHoveredCity(null); }, [zoomLevel]); // eslint-disable-line react-hooks/exhaustive-deps

  const cascadeActive = phase === 'cascade_running' || phase === 'shock_triggered';

  const { formedNodeIds, formedEdgeKeys, labelsReady, isForming } = useFormationAnimation(nodes, edges);

  // Stable arc data — rebuilt only when edges list or node positions change
  // (after initial load, never changes during simulation)
  const stableEdgeData = useMemo(
    () => buildStableEdgeData(edges, nodes),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [edges],
  );

  const handleHover = useCallback((nodeId: number | null) => {
    if (nodeId === null) { setHoveredNode(null); return; }
    const neighbors = getNeighborhood(nodeId, adjacency);
    setHoveredNode(nodeId, neighbors);
  }, [adjacency, setHoveredNode]);

  const handleSelect = useCallback((node: GraphNode | null) => {
    if (!node) { setSelectedNode(null); return; }
    const neighbors = getNeighborhood(node.id, adjacency);
    setSelectedNode(node.id, neighbors);
  }, [adjacency, setSelectedNode]);

  const handleHubSelect = useCallback((hub: HubAggregate | null) => {
    setSelectedCity(hub ? hub.hubName : null);
  }, [setSelectedCity]);

  const handleCitySelect = useCallback((hub: CityHub | null) => {
    setSelectedCity(hub ? hub.cityName : null);
  }, [setSelectedCity]);

  // Anchor for merged-focus mode: selection wins over hover so the merged
  // arcs don't jitter as the user moves the mouse around once they've picked.
  const focusAnchorId = selectedNodeId ?? hoveredNodeId;
  // Merge focused firm-to-firm edges into one arc per destination city when
  // a node is focused, the cascade is idle, and the formation animation is
  // not running. Cascade keeps individual arcs so per-firm contagion stays
  // visible; formation keeps individual arcs so each one can fade in.
  const useMergedFocus = focusAnchorId !== null && !cascadeActive && !isForming;

  // Split memos so edge layers don't rebuild when only nodes change
  const edgeLayers = useMemo(
    () => buildEdgeLayers(stableEdgeData, {
      hoveredNodeId, hoveredNeighborIds, selectedNodeId,
      highlightedIds, cascadeActive, defaultedNodeIds,
      formedEdgeKeys, isForming,
      mergedFocus: useMergedFocus,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stableEdgeData, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, cascadeActive, defaultedNodeIds, formedEdgeKeys, isForming, useMergedFocus, zoomLevel],
  );

  const focusEdges = useMemo(
    () => useMergedFocus ? deriveFocusEdges(focusAnchorId, nodes, edgeIndex) : [],
    [useMergedFocus, focusAnchorId, nodes, edgeIndex],
  );

  const focusEdgeLayer = useMemo(
    () => useMergedFocus && focusEdges.length > 0 ? buildFocusEdgeLayer({ edges: focusEdges }) : [],
    [useMergedFocus, focusEdges],
  );

  const nodeLayers = useMemo(
    () => buildNodeLayers({
      nodes: nodeList,
      hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds,
      onHover: handleHover, onSelect: handleSelect,
      formedNodeIds, isForming,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nodeList, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, handleHover, handleSelect, formedNodeIds, isForming, zoomLevel],
  );

  const labelLayer = useMemo(
    () => buildLabelLayer({
      nodes: nodeList, hoveredNodeId, hoveredNeighborIds,
      selectedNodeId, highlightedIds, zoom: zoomBucket, labelsReady,
    }),
    [nodeList, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, zoomBucket, labelsReady],
  );

  // Neighbor hubs of the focused hub (region zoom). Used by the hub layer to
  // keep arc endpoints lit while everything else dims.
  const hubAnchorName = selectedCityName ?? hoveredCityName;
  const neighborHubs = useMemo(() => {
    if (!hubAnchorName) return new Set<string>();
    const set = new Set<string>();
    for (const e of hubEdges) {
      if (e.sourceHub === hubAnchorName) set.add(e.targetHub);
      else if (e.targetHub === hubAnchorName) set.add(e.sourceHub);
    }
    return set;
  }, [hubAnchorName, hubEdges]);

  const regionHubLayers = useMemo(
    () => buildCityHubLayers({
      hubs: hubAggregates, selectedHubName: selectedCityName,
      hoveredHubName: hoveredCityName, neighborHubs,
      onSelect: handleHubSelect, onHover: setHoveredCity,
    }),
    [hubAggregates, selectedCityName, hoveredCityName, neighborHubs, handleHubSelect, setHoveredCity, zoomLevel],
  );

  const regionEdgeLayers = useMemo(
    () => buildHubEdgeLayer({ edges: hubEdges, hoveredHubName: hoveredCityName, selectedHubName: selectedCityName }),
    [hubEdges, hoveredCityName, selectedCityName, zoomLevel],
  );

  // Neighbor cities of the focused city (city zoom). Each cityEdge's `key` is
  // `${a}||${b}` where a/b are the two city names sorted; split it to find
  // the other endpoint relative to the anchor.
  const cityAnchorName = selectedCityName ?? hoveredCityName;
  const neighborCities = useMemo(() => {
    if (!cityAnchorName) return new Set<string>();
    const set = new Set<string>();
    for (const e of cityEdges) {
      const [a, b] = e.key.split('||');
      if (a === cityAnchorName) set.add(b);
      else if (b === cityAnchorName) set.add(a);
    }
    return set;
  }, [cityAnchorName, cityEdges]);

  const cityBlobLayers = useMemo(
    () => buildCityBlobLayers({
      hubs: cityHubs, selectedCityName, hoveredCityName, neighborCities,
      onSelect: handleCitySelect, onHover: setHoveredCity,
    }),
    [cityHubs, selectedCityName, hoveredCityName, neighborCities, handleCitySelect, setHoveredCity, zoomLevel],
  );

  const cityEdgeLayers = useMemo(
    () => buildCityEdgeLayer({ edges: cityEdges, hoveredCityName, selectedCityName }),
    [cityEdges, hoveredCityName, selectedCityName, zoomLevel],
  );

  // One bright label per blob, mirroring the firm-label palette: anchor pops
  // in cyan, neighbours stay legible, idle is muted, dimmed elements fade.
  const hubLabelLayer = useMemo(
    () => buildBlobLabelLayer({
      kind: 'hub', items: hubAggregates,
      anchorName: selectedCityName, hoveredName: hoveredCityName,
      neighbors: neighborHubs,
    }),
    [hubAggregates, selectedCityName, hoveredCityName, neighborHubs],
  );

  const cityLabelLayer = useMemo(
    () => buildBlobLabelLayer({
      kind: 'city', items: cityHubs,
      anchorName: selectedCityName, hoveredName: hoveredCityName,
      neighbors: neighborCities,
    }),
    [cityHubs, selectedCityName, hoveredCityName, neighborCities],
  );

  const layers = regionMode
    ? [...regionEdgeLayers, ...regionHubLayers, hubLabelLayer]
    : cityMode
    ? [...cityEdgeLayers, ...cityBlobLayers, cityLabelLayer]
    : [...edgeLayers, ...focusEdgeLayer, ...nodeLayers, labelLayer];

  // Deck.gl owns the camera. This callback fires on every drag/zoom tick but we
  // only commit to React state when the bucketed zoom actually changes — most
  // ticks are no-ops, so the label layers don't rebuild during a smooth drag.
  const onViewStateChange = useCallback(({ viewState: vs }: { viewState: ViewState }) => {
    const next = bucketizeZoom(vs.zoom);
    setZoomBucket((prev) => (prev === next ? prev : next));
  }, []);

  // Click on empty background → clear selection. A pick on a node sets info.object,
  // which the node layer's onClick already handles, so we only act when no object
  // was picked.
  const onBackgroundClick = useCallback(
    (info: { object?: unknown }) => {
      if (!info.object) clearSelection();
    },
    [clearSelection],
  );

  return (
    <div className="absolute inset-0" style={{ willChange: 'transform' }}>
      <DeckGL
        views={MAIN_VIEW}
        initialViewState={INITIAL_VIEW}
        onViewStateChange={onViewStateChange as (args: unknown) => void}
        onClick={onBackgroundClick as (args: unknown) => void}
        layers={layers}
        _animate
        useDevicePixels={1}
        getCursor={({ isDragging, isHovering }: { isDragging: boolean; isHovering: boolean }) =>
          isDragging ? 'grabbing' : isHovering ? 'crosshair' : 'grab'
        }
      >
        <Map
          reuseMaps
          mapStyle={MAP_STYLE}
          renderWorldCopies={false}
          attributionControl={false}
          antialias={false}
        />
      </DeckGL>
    </div>
  );
}
