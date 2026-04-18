'use client';
import { useState, useEffect, useRef } from 'react';
import type { GraphNode, GraphEdge } from '@/types/graph';

// Stable references so the early-return path never creates new Set objects.
const EMPTY_NODE_IDS = new Set<number>();
const EMPTY_EDGE_KEYS = new Set<string>();

export function useFormationAnimation(
  nodes: Map<number, GraphNode>,
  edges: GraphEdge[],
): {
  formedNodeIds: Set<number>;
  formedEdgeKeys: Set<string>;
  labelsReady: boolean;
  isForming: boolean;
} {
  const [formedNodeIds, setFormedNodeIds] = useState<Set<number>>(new Set());
  const [formedEdgeKeys, setFormedEdgeKeys] = useState<Set<string>>(new Set());
  const [labelsReady, setLabelsReady] = useState(false);

  // Shadow set for closure-safe edge completion checks — never triggers rerenders.
  const shadowFormed = useRef<Set<number>>(new Set());
  const hasStarted = useRef(false);
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (nodes.size === 0 || hasStarted.current) return;
    hasStarted.current = true;

    // Build edge adjacency index once before scheduling any timeouts.
    const adjacency = new Map<number, GraphEdge[]>();
    for (const edge of edges) {
      let dList = adjacency.get(edge.debtorId);
      if (dList === undefined) {
        dList = [];
        adjacency.set(edge.debtorId, dList);
      }
      dList.push(edge);

      let cList = adjacency.get(edge.creditorId);
      if (cList === undefined) {
        cList = [];
        adjacency.set(edge.creditorId, cList);
      }
      cList.push(edge);
    }

    // Group nodes by hubId, then by cityName.
    // hubId: 0=NYC, 1=London, 2=Tokyo, 3=HongKong, 4=Dubai
    const hubMap = new Map<number, Map<string, GraphNode[]>>();
    for (const node of nodes.values()) {
      let cityMap = hubMap.get(node.hubId);
      if (cityMap === undefined) {
        cityMap = new Map<string, GraphNode[]>();
        hubMap.set(node.hubId, cityMap);
      }
      let cityNodes = cityMap.get(node.cityName);
      if (cityNodes === undefined) {
        cityNodes = [];
        cityMap.set(node.cityName, cityNodes);
      }
      cityNodes.push(node);
    }

    let lastRevealAt = 0;

    // Iterate hubs in ascending hubId order for determinism.
    const sortedHubIds = Array.from(hubMap.keys()).sort((a, b) => a - b);

    for (const hubId of sortedHubIds) {
      const cityMap = hubMap.get(hubId)!;
      const hubStart = hubId * 500; // ms

      // Sort cities alphabetically for determinism.
      const sortedCities = Array.from(cityMap.keys()).sort();

      for (let ci = 0; ci < sortedCities.length; ci++) {
        const cityName = sortedCities[ci];
        const cityNodes = cityMap.get(cityName)!;
        const revealAt = hubStart + ci * 60;

        if (revealAt > lastRevealAt) lastRevealAt = revealAt;

        const handle = setTimeout(() => {
          // 1. Mark all city nodes in the shadow set first.
          for (const cityNode of cityNodes) {
            shadowFormed.current.add(cityNode.id);
          }

          // 2. Scan edges incident to any city node; add those whose both
          //    endpoints are now in the shadow set.
          const newEdgeKeys: string[] = [];
          for (const cityNode of cityNodes) {
            const incidentEdges = adjacency.get(cityNode.id);
            if (incidentEdges === undefined) continue;
            for (const edge of incidentEdges) {
              if (
                shadowFormed.current.has(edge.debtorId) &&
                shadowFormed.current.has(edge.creditorId)
              ) {
                newEdgeKeys.push(`${edge.debtorId}:${edge.creditorId}`);
              }
            }
          }

          // 3. Commit node state update.
          setFormedNodeIds(prev => {
            const s = new Set(prev);
            for (const n of cityNodes) s.add(n.id);
            return s;
          });

          // 4. Commit edge state update only when there is something new.
          if (newEdgeKeys.length > 0) {
            setFormedEdgeKeys(prev => {
              const s = new Set(prev);
              for (const k of newEdgeKeys) s.add(k);
              return s;
            });
          }
        }, revealAt);

        timeouts.current.push(handle);
      }
    }

    // labelsReady fires 800ms after the last city reveal.
    const labelsHandle = setTimeout(() => {
      setLabelsReady(true);
    }, lastRevealAt + 800);

    timeouts.current.push(labelsHandle);

    return () => {
      hasStarted.current = false;
      for (const handle of timeouts.current) clearTimeout(handle);
      timeouts.current = [];
    };
  }, [nodes.size]); // eslint-disable-line react-hooks/exhaustive-deps

  // Derived — no useState needed. isForming is true from the very first render
  // where nodes exist, until labelsReady fires. This avoids the one-frame flash
  // caused by useEffect running after paint with isForming still false.
  const isForming = nodes.size > 0 && !labelsReady;

  if (nodes.size === 0) {
    return { formedNodeIds: EMPTY_NODE_IDS, formedEdgeKeys: EMPTY_EDGE_KEYS, labelsReady: false, isForming: false };
  }

  return { formedNodeIds, formedEdgeKeys, labelsReady, isForming };
}
