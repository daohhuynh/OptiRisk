import { create } from 'zustand';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ConnectionState {
  status: ConnectionStatus;
  isConnected: boolean;
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
  isConnected: false,
  lastMessageTime: null,
  lastLatencyUs: 0,
  reconnectCount: 0,
  setStatus: (status) => set({ status, isConnected: status === 'connected' }),
  setLatency: (lastLatencyUs) => set({ lastLatencyUs }),
  recordMessage: () => set({ lastMessageTime: Date.now() }),
  incrementReconnect: () => set((s) => ({ reconnectCount: s.reconnectCount + 1 })),
}));
