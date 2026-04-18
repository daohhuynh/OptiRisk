'use client';
import { useUIStore } from '@/store/uiStore';

export function useViewportState() {
  const {
    viewportLng,
    viewportLat,
    viewportZoom,
    viewportPitch,
    viewportBearing,
    setViewport,
  } = useUIStore();

  return {
    initialViewState: {
      longitude: viewportLng,
      latitude: viewportLat,
      zoom: viewportZoom,
      pitch: viewportPitch,
      bearing: viewportBearing,
    },
    setViewport,
  };
}
