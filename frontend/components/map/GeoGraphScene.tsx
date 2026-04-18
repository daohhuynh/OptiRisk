'use client';

import { useMemo, useCallback, useState } from 'react';
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
import { buildGeoLabelsLayer } from './layers/geoLabelsLayer';
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

const MIN_ZOOM = 1.8;
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
  const phase              = useSimulationStore(s => s.phase);

  // Only the bucketed zoom is tracked in React state. Camera (lon/lat/pitch/
  // bearing/exact zoom) lives entirely inside deck.gl in uncontrolled mode.
  const [zoomBucket, setZoomBucket] = useState(() => bucketizeZoom(INITIAL_VIEW.zoom));

  const nodeList     = useMemo(() => Array.from(nodes.values()), [nodes]);
  const adjacency    = useMemo(() => buildAdjacencyIndex(edges), [edges]);
  const cascadeActive = phase === 'cascade_running' || phase === 'shock_triggered';

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

  // Split memos so edge layers don't rebuild when only nodes change
  const edgeLayers = useMemo(
    () => buildEdgeLayers(stableEdgeData, {
      hoveredNodeId,
      hoveredNeighborIds,
      selectedNodeId,
      highlightedIds,
      cascadeActive,
      defaultedNodeIds,
    }),
    [stableEdgeData, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, cascadeActive, defaultedNodeIds],
  );

  const nodeLayers = useMemo(
    () => buildNodeLayers({
      nodes: nodeList,
      hoveredNodeId,
      hoveredNeighborIds,
      selectedNodeId,
      highlightedIds,
      onHover: handleHover,
      onSelect: handleSelect,
    }),
    [nodeList, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, handleHover, handleSelect],
  );

  const labelLayer = useMemo(
    () => buildLabelLayer({
      nodes: nodeList,
      hoveredNodeId,
      hoveredNeighborIds,
      selectedNodeId,
      highlightedIds,
      zoom: zoomBucket,
    }),
    [nodeList, hoveredNodeId, hoveredNeighborIds, selectedNodeId, highlightedIds, zoomBucket],
  );

  const geoLabelsLayer = useMemo(
    () => buildGeoLabelsLayer(nodeList, zoomBucket),
    [nodeList, zoomBucket],
  );

  const layers = [
    ...edgeLayers,
    ...nodeLayers,
    ...(geoLabelsLayer ? [geoLabelsLayer] : []),
    labelLayer,
  ];

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
