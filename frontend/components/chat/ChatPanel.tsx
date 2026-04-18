'use client';

import { useEffect, useRef } from 'react';
import { useSimulationStore } from '@/store/simulationStore';
import { useUIStore } from '@/store/uiStore';
import CommandInput from './CommandInput';

const EVENT_COLORS: Record<string, string> = {
  shock_sent:    '#ff8c00',
  node_default:  '#ff2020',
  var_report:    '#a855f7',
  cascade_start: '#ff5000',
  cascade_end:   '#00e5ff',
  connected:     '#00e5ff',
  disconnected:  '#4a7a9b',
};

function formatTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

export default function ChatPanel() {
  // Granular selectors
  const events    = useSimulationStore(s => s.events);
  const addEvent  = useSimulationStore(s => s.addEvent);
  const toggleChat = useUIStore(s => s.toggleChat);

  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const handleCommand = (cmd: string) => {
    addEvent({
      id: Math.random().toString(36).slice(2),
      type: 'connected',
      timestamp: Date.now(),
      label: `> ${cmd.toUpperCase()}`,
    });
  };

  const isChatOpen = useUIStore(s => s.isChatOpen);

  if (!isChatOpen) {
    return (
      <button
        onClick={toggleChat}
        className="flex flex-col items-center justify-center w-8 gap-2 py-3 transition-colors"
        style={{
          background: 'rgba(4,8,16,0.85)',
          border: '1px solid rgba(0,200,255,0.12)',
          color: '#4a7a9b',
        }}
        title="Open event log"
      >
        <span className="text-[#00e5ff] text-xs">›</span>
        <span
          className="text-[9px] tracking-[0.2em] text-[#4a7a9b]"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontFamily: 'Chakra Petch, sans-serif' }}
        >
          EVENTS
        </span>
      </button>
    );
  }

  return (
    <div
      className="panel-bracket flex flex-col h-full text-[#c8e6f5] overflow-hidden"
      style={{ fontFamily: 'JetBrains Mono, monospace' }}
    >
      <div
        className="flex items-center justify-between px-3 py-2 flex-shrink-0"
        style={{ borderBottom: '1px solid rgba(0,200,255,0.1)' }}
      >
        <span
          className="text-[10px] font-semibold tracking-[0.2em] text-[#4a7a9b]"
          style={{ fontFamily: 'Chakra Petch, sans-serif' }}
        >
          EVENT LOG
        </span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[#4a7a9b] font-mono">{events.length} EVENTS</span>
          <button
            onClick={toggleChat}
            className="text-[#4a7a9b] hover:text-[#c8e6f5] text-xs transition-colors"
          >
            ‹
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
        {events.length === 0 && (
          <div className="text-[#2a4a6a] text-[10px] pt-2">
            SYSTEM READY. AWAITING SHOCK TRIGGER.
          </div>
        )}
        {events.map((evt) => (
          <div key={evt.id} className="flex items-start gap-2">
            <span className="text-[#2a4a6a] text-[9px] leading-4 flex-shrink-0 tabular-nums">
              {formatTime(evt.timestamp)}
            </span>
            <span
              className="text-[10px] leading-4 break-all"
              style={{ color: EVENT_COLORS[evt.type] ?? '#c8e6f5' }}
            >
              {evt.label}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <CommandInput onSubmit={handleCommand} />
    </div>
  );
}
