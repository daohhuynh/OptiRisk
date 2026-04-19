'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef } from 'react';
import { useGraphStore } from '@/store/graphStore';
import { parseInitialSnapshot } from '@/lib/graph/indexing';

const GeoGraphScene = dynamic(() => import('./GeoGraphScene'), { ssr: false });

export default function MapContainer() {
  const loadSnapshot = useGraphStore(s => s.loadSnapshot);
  const totalNodes   = useGraphStore(s => s.totalNodes);
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    // Load initial graph state from JSON
    fetch('/optirisk_initial_state.json')
      .then((r) => r.json())
      .then((json) => {
        const { nodes, edges } = parseInitialSnapshot(json);
        loadSnapshot(nodes, edges);
      })
      .catch(console.error);

  }, [loadSnapshot]);

  return (
    <div className="absolute inset-0 bg-[#040810]">
      {totalNodes === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-terminal-muted font-mono text-sm tracking-widest animate-pulse">
            LOADING COUNTERPARTY GRAPH...
          </div>
        </div>
      )}
      <GeoGraphScene />
    </div>
  );
}
