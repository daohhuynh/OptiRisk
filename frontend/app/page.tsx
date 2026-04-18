'use client';

import dynamic from 'next/dynamic';
import TopControls from '@/components/panels/TopControls';
import NodeInfoCard from '@/components/panels/NodeInfoCard';
import StatusBar from '@/components/panels/StatusBar';
import ChatPanel from '@/components/chat/ChatPanel';
import { useUIStore } from '@/store/uiStore';

const MapContainer = dynamic(() => import('@/components/map/MapContainer'), { ssr: false });

export default function Home() {
  const { isChatOpen } = useUIStore();

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

        {/* Node info card — right side */}
        <div className="pointer-events-auto absolute top-16 right-4">
          <NodeInfoCard />
        </div>

        {/* Chat / event log — left side */}
        {isChatOpen && (
          <div className="pointer-events-auto absolute bottom-12 left-4 top-16 w-80">
            <ChatPanel />
          </div>
        )}

        {/* Bottom status bar */}
        <div className="pointer-events-auto absolute bottom-0 left-0 right-0">
          <StatusBar />
        </div>
      </div>
    </main>
  );
}
