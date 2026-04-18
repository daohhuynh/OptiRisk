import { create } from 'zustand';

interface UIState {
  hoveredNodeId: number | null;
  hoveredNeighborIds: Set<number>;
  selectedNodeId: number | null;
  highlightedNeighborIds: Set<number>;
  isChatOpen: boolean;
  isNodeInfoOpen: boolean;
  viewportLng: number;
  viewportLat: number;
  viewportZoom: number;
  viewportPitch: number;
  viewportBearing: number;
  setHoveredNode: (id: number | null, neighbors?: number[]) => void;
  setSelectedNode: (id: number | null, neighbors?: number[]) => void;
  clearSelection: () => void;
  toggleChat: () => void;
  setViewport: (v: Partial<Pick<UIState, 'viewportLng' | 'viewportLat' | 'viewportZoom' | 'viewportPitch' | 'viewportBearing'>>) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  hoveredNodeId: null,
  hoveredNeighborIds: new Set(),
  selectedNodeId: null,
  highlightedNeighborIds: new Set(),
  isChatOpen: true,
  isNodeInfoOpen: false,
  viewportLng: 20,
  viewportLat: 25,
  viewportZoom: 2.8,
  viewportPitch: 35,
  viewportBearing: 0,

  setHoveredNode: (id, neighbors = []) => {
    if (id === get().hoveredNodeId) return;
    set({
      hoveredNodeId: id,
      hoveredNeighborIds: id === null ? new Set() : new Set(neighbors),
    });
  },

  setSelectedNode: (id, neighbors = []) => set({
    selectedNodeId: id,
    highlightedNeighborIds: new Set(neighbors),
    isNodeInfoOpen: id !== null,
    hoveredNodeId: null,
    hoveredNeighborIds: new Set(),
  }),

  clearSelection: () => set({
    selectedNodeId: null,
    highlightedNeighborIds: new Set(),
    isNodeInfoOpen: false,
  }),

  toggleChat: () => set((s) => ({ isChatOpen: !s.isChatOpen })),

  setViewport: (v) => set((s) => ({ ...s, ...v })),
}));
