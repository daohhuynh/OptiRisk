'use client';

import { useEffect, useRef, useState } from 'react';
import { useSimulationStore } from '@/store/simulationStore';
import { useUIStore } from '@/store/uiStore';
import CommandInput from './CommandInput';
import { wsService } from '@/services/websocket';
import { encodeShockPayload } from '@/lib/binary/encodeShock';
import type { ShockConfig, ShockType } from '@/types/simulation';

const EVENT_COLORS: Record<string, string> = {
  shock_sent: '#ff8c00',
  node_default: '#ff2020',
  var_report: '#a855f7',
  cascade_start: '#ff5000',
  cascade_end: '#00e5ff',
  connected: '#00e5ff',
  disconnected: '#4a7a9b',
};

function formatTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

// The Base64 to Binary Engine
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function shockTypeFromWire(value: number): ShockType {
  switch (value) {
    case 1: return 'lehman2008';
    case 2: return 'covid2020';
    case 3: return 'rate_hike';
    case 4: return 'crypto_crash';
    default: return 'custom';
  }
}

function decodeShockConfig(buf: ArrayBuffer): ShockConfig {
  const v = new DataView(buf);
  return {
    targetNodeId: v.getUint32(4, true),
    shockType: shockTypeFromWire(v.getUint32(8, true)),
    equitiesDelta: v.getFloat64(12, true),
    realEstateDelta: v.getFloat64(20, true),
    cryptoDelta: v.getFloat64(28, true),
    treasuriesDelta: v.getFloat64(36, true),
    corpBondsDelta: v.getFloat64(44, true),
  };
}

function localCommandToShock(cmd: string): ShockConfig | null {
  const lowered = cmd.toLowerCase();
  const assetDeltas = {
    equitiesDelta: /\b(equities|equity|stocks?|spx|s&p|nasdaq)\b/.test(lowered),
    realEstateDelta: /\b(real[\s_-]?estate|property|housing|reit)\b/.test(lowered),
    cryptoDelta: /\b(crypto|bitcoin|btc|eth|ethereum)\b/.test(lowered),
    treasuriesDelta: /\b(treasur(?:y|ies)|rates?|duration|bonds?)\b/.test(lowered),
    corpBondsDelta: /\b(corp(?:orate)?[\s_-]?bonds?|credit|ig|high[\s_-]?yield|hy)\b/.test(lowered),
  };
  const selected = Object.entries(assetDeltas).find(([, matches]) => matches)?.[0] as keyof typeof assetDeltas | undefined;
  const cryptoCrash = /\b(crypto|bitcoin|btc|eth|ethereum).*\b(crash|crashes|crashed|collapse|collapses|meltdown|tanks?)\b|\b(crash|crashes|crashed|collapse|collapses|meltdown|tanks?)\b.*\b(crypto|bitcoin|btc|eth|ethereum)\b/.test(lowered);
  if (!selected && !cryptoCrash) return null;

  const numberMatch = cmd.match(/[-+]?\d+(?:\.\d+)?\s*%/);
  const parsed = cryptoCrash ? -0.8 : numberMatch ? Number.parseFloat(numberMatch[0]) : -10;
  const asksForDrop = /\b(drop|down|fall|crash|sell|stress|shock|lose|loss|haircut|negative)\b/i.test(cmd);
  const signed = parsed > 0 && asksForDrop ? -parsed : parsed;
  const scaled = cryptoCrash ? signed : Math.abs(signed) > 1 ? signed / 100 : signed;
  const delta = Number.isFinite(scaled) ? Math.max(-0.95, Math.min(0.95, scaled)) : 0;
  const selectedAsset = cryptoCrash ? 'cryptoDelta' : selected;

  return {
    targetNodeId: 0xFFFFFFFF,
    shockType: cryptoCrash ? 'crypto_crash' as ShockType : 'custom' as ShockType,
    equitiesDelta: selectedAsset === 'equitiesDelta' ? delta : 0,
    realEstateDelta: selectedAsset === 'realEstateDelta' ? delta : 0,
    cryptoDelta: selectedAsset === 'cryptoDelta' ? delta : 0,
    treasuriesDelta: selectedAsset === 'treasuriesDelta' ? delta : 0,
    corpBondsDelta: selectedAsset === 'corpBondsDelta' ? delta : 0,
  };
}

export default function ChatPanel() {
  const events = useSimulationStore(s => s.events);
  const addEvent = useSimulationStore(s => s.addEvent);
  const recordShockSent = useSimulationStore(s => s.recordShockSent);
  const toggleChat = useUIStore(s => s.toggleChat);
  const isChatOpen = useUIStore(s => s.isChatOpen);

  const [isProcessing, setIsProcessing] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  const handleCommand = async (cmd: string) => {
    if (!cmd.trim() || isProcessing) return;

    // Using 'connected' to bypass the TS strict type checking cleanly
    addEvent({
      id: Math.random().toString(36).slice(2),
      type: 'connected',
      timestamp: Date.now(),
      label: `> USER: ${cmd}`,
    });

    setIsProcessing(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: cmd }] })
      });

      if (!response.ok) throw new Error(`API Error ${response.status}`);

      const data = await response.json();

      if (data.type === 'binary_command') {
        const rawBuffer = base64ToArrayBuffer(data.payload);
        if (!wsService.sendBinary(rawBuffer)) throw new Error('WEBSOCKET_OFFLINE');
        recordShockSent(decodeShockConfig(rawBuffer));

        addEvent({
          id: Math.random().toString(36).slice(2),
          type: 'shock_sent',
          timestamp: Date.now(),
          label: `> K2_ENGINE: BINARY SHOCK PAYLOAD INJECTED`,
        });
      } else if (data.content) {
        addEvent({
          id: Math.random().toString(36).slice(2),
          type: 'connected',
          timestamp: Date.now(),
          label: `> K2_AI: ${data.content.toUpperCase()}`,
        });
      }
    } catch (error) {
      const fallbackShock = localCommandToShock(cmd);
      if (fallbackShock) {
        if (!wsService.sendBinary(encodeShockPayload(fallbackShock))) {
          addEvent({
            id: Math.random().toString(36).slice(2),
            type: 'node_default',
            timestamp: Date.now(),
            label: `> SYS_ERR: WEBSOCKET_OFFLINE`,
          });
          return;
        }
        recordShockSent(fallbackShock);
        addEvent({
          id: Math.random().toString(36).slice(2),
          type: 'shock_sent',
          timestamp: Date.now(),
          label: `> LOCAL_PARSER: BINARY SHOCK PAYLOAD INJECTED`,
        });
        setIsProcessing(false);
        return;
      }

      addEvent({
        id: Math.random().toString(36).slice(2),
        type: 'node_default',
        timestamp: Date.now(),
        label: `> SYS_ERR: ${error instanceof Error ? error.message : 'K2 ROUTE OFFLINE'}`,
      });
    } finally {
      setIsProcessing(false);
    }
  };

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
        <span className="text-[#00e5ff] text-xs">&gt;</span>
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
        {isProcessing && (
          <div className="flex items-start gap-2 animate-pulse">
            <span className="text-[#2a4a6a] text-[9px] leading-4 flex-shrink-0 tabular-nums">
              {formatTime(Date.now())}
            </span>
            <span className="text-[10px] leading-4 break-all text-[#a855f7]">
              &gt; K2_AI: COMPUTING VECTOR TRAJECTORY...
            </span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <CommandInput onSubmit={handleCommand} disabled={isProcessing} />
    </div>
  );
}
