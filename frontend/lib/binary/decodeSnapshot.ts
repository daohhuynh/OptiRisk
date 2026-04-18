import type { GraphNode } from '@/types/graph';
import { getNodeState } from '@/types/graph';
import { MSG_HEADER_SIZE, NODE_SNAPSHOT_SIZE, HUB_NAMES } from './schema';

export function decodeNodeSnapshot(buf: ArrayBuffer, offset = MSG_HEADER_SIZE): Partial<GraphNode> | null {
  if (buf.byteLength < offset + NODE_SNAPSHOT_SIZE) return null;
  const v = new DataView(buf, offset);
  const hubId = v.getUint8(25);
  const riskScore = v.getFloat32(4, true);
  const isDefaulted = v.getUint8(24) === 1;
  return {
    id:            v.getUint32(0, true),
    riskScore,
    nav:           v.getFloat64(8, true),
    exposureTotal: v.getFloat64(16, true),
    isDefaulted,
    hubId,
    hub:           HUB_NAMES[hubId] ?? 'NYC',
    state:         getNodeState(riskScore, isDefaulted),
    cascadeDepth:  0,
  };
}
