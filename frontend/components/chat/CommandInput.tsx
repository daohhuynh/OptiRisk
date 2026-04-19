'use client';

import { useState, useCallback, KeyboardEvent } from 'react';
import { wsService } from '@/services/websocket';

// Add this helper function outside your component
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

interface Props {
  onSubmit: (command: string) => void;
  disabled?: boolean;
}

export default function CommandInput({ onSubmit, disabled = false }: Props) {
  const [value, setValue] = useState('');

  const handleKey = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && value.trim()) {
      onSubmit(value.trim());
      setValue('');
    }
  }, [value, onSubmit]);

  return (
    <div
      className="flex items-center gap-2 px-3 py-2"
      style={{ borderTop: '1px solid rgba(0,200,255,0.1)' }}
    >
      <span className="text-[#00e5ff] font-mono text-xs select-none">{'>'}_</span>
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKey}
        disabled={disabled}
        placeholder="shock node_id | status | reset"
        className="flex-1 bg-transparent text-[#c8e6f5] text-xs font-mono outline-none placeholder-[#2a4a6a] disabled:opacity-40"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
        spellCheck={false}
        autoComplete="off"
      />
    </div>
  );
}
