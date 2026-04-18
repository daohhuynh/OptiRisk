import { create } from 'zustand';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ConnectionState {
  status: ConnectionStatus;
  lastMessageTime: number | null;
  lastLatencyUs: number;
  reconnectCount: number;
  setStatus: (s: ConnectionStatus) => void;
  setLatency: (us: number) => void;
  recordMessage: () => void;
  incrementReconnect: () => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  status: 'disconnected',
  lastMessageTime: null,
  lastLatencyUs: 0,
  reconnectCount: 0,
  setStatus: (status) => set({ status }),
  setLatency: (lastLatencyUs) => set({ lastLatencyUs }),
  recordMessage: () => set({ lastMessageTime: Date.now() }),
  incrementReconnect: () => set((s) => ({ reconnectCount: s.reconnectCount + 1 })),
}));
