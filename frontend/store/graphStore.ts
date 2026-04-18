import { create } from 'zustand';
import type { GraphNode, GraphEdge } from '@/types/graph';
import { getNodeState } from '@/types/graph';
import type { TickDeltaMsg } from '@/types/simulation';

interface GraphState {
  nodes: Map<number, GraphNode>;
  edges: GraphEdge[];
  heroFirmId: number | null;
  totalNodes: number;
  totalEdges: number;
  changedNodeIds: Set<number>;
  defaultedNodeIds: Set<number>;
  loadSnapshot: (nodes: GraphNode[], edges: GraphEdge[]) => void;
  applyTickDelta: (msg: TickDeltaMsg) => void;
  clearChangedNodes: () => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: new Map(),
  edges: [],
  heroFirmId: null,
  totalNodes: 0,
  totalEdges: 0,
  changedNodeIds: new Set(),
  defaultedNodeIds: new Set(),

  loadSnapshot: (nodes, edges) => {
    const nodeMap = new Map<number, GraphNode>();
    let heroId: number | null = null;
    for (const n of nodes) {
      nodeMap.set(n.id, n);
      if (n.isHeroFirm) heroId = n.id;
    }
    set({
      nodes: nodeMap,
      edges,
      heroFirmId: heroId,
      totalNodes: nodes.length,
      totalEdges: edges.length,
      changedNodeIds: new Set(),
      defaultedNodeIds: new Set(),
    });
  },

  applyTickDelta: (msg) => {
    const { nodes, changedNodeIds, defaultedNodeIds } = get();
    const existing = nodes.get(msg.nodeId);
    if (!existing) return;

    const updated: GraphNode = {
      ...existing,
      riskScore: msg.riskScore,
      nav: msg.nav,
      exposureTotal: msg.exposureTotal,
      isDefaulted: msg.isDefaulted,
      cascadeDepth: msg.cascadeDepth,
      state: getNodeState(msg.riskScore, msg.isDefaulted),
    };

    const newNodes = new Map(nodes);
    newNodes.set(msg.nodeId, updated);
    const newChanged = new Set(changedNodeIds);
    newChanged.add(msg.nodeId);
    const newDefaulted = msg.isDefaulted
      ? new Set([...defaultedNodeIds, msg.nodeId])
      : defaultedNodeIds;

    set({ nodes: newNodes, changedNodeIds: newChanged, defaultedNodeIds: newDefaulted });
  },

  clearChangedNodes: () => set({ changedNodeIds: new Set() }),
}));
