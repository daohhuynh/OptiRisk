'use client';

import dynamic from 'next/dynamic';
import TopControls from '@/components/panels/TopControls';
import NodeInfoCard from '@/components/panels/NodeInfoCard';
import CityHubPanel from '@/components/panels/CityHubPanel';
import StatusBar from '@/components/panels/StatusBar';
import ChatPanel from '@/components/chat/ChatPanel';
import { useUIStore } from '@/store/uiStore';
import { useEffect } from 'react';
import { wsService } from '@/services/websocket';

// Dynamic imports must live OUTSIDE the component
const MapContainer = dynamic(() => import('@/components/map/MapContainer'), { ssr: false });

export default function Home() {
  
  // [THE IGNITION SWITCH]
  // Must live INSIDE the component, before the return statement
  useEffect(() => {
    wsService.start();
    return () => wsService.stop(); // Clean up if the component unmounts
  }, []);

  const selectedCityName = useUIStore(s => s.selectedCityName);

  return (
    <main className="relative w-screen h-screen overflow-hidden bg-[#040810] scan-overlay">
      {/* Full-screen map */}
      <MapContainer />

      {/* HUD overlay */}
      <div className="absolute inset-0 pointer-events-none z-10">

        {/* Top controls strip */}
        <div className="pointer-events-auto absolute top-0 left-0 right-0">
          <TopControls />
        </div>

        {/* Right panel: city hub list OR standalone node info card */}
        <div className="pointer-events-auto absolute top-16 right-4">
          {selectedCityName ? <CityHubPanel /> : <NodeInfoCard />}
        </div>

        {/* Chat / event log — left side, always rendered (collapsed = tab only) */}
        <div className="pointer-events-auto absolute bottom-12 left-4 top-16">
          <ChatPanel />
        </div>

        {/* Bottom status bar */}
        <div className="pointer-events-auto absolute bottom-0 left-0 right-0">
          <StatusBar />
        </div>
      </div>
    </main>
  );
}