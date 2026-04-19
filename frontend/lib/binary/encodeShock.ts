import type { ShockConfig } from '@/types/simulation';
import { MsgType, SHOCK_PACKET_SIZE, SHOCK_PAYLOAD_SIZE } from './schema';

const SHOCK_TYPE_WIRE: Record<string, number> = {
  custom: 0, lehman2008: 1, covid2020: 2, rate_hike: 3, crypto_crash: 4,
};

function clampDelta(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-0.95, Math.min(0.95, x));
}

export function encodeShockPayload(config: ShockConfig): ArrayBuffer {
  const buf = new ArrayBuffer(SHOCK_PACKET_SIZE);
  const v = new DataView(buf);
  v.setUint8(0, MsgType.ShockPayload);
  v.setUint8(1, 0);
  v.setUint16(2, SHOCK_PAYLOAD_SIZE, true);
  v.setUint32(4, config.targetNodeId, true);
  v.setUint32(8, SHOCK_TYPE_WIRE[config.shockType] ?? 0, true);
  v.setFloat64(12, clampDelta(config.equitiesDelta), true);
  v.setFloat64(20, clampDelta(config.realEstateDelta), true);
  v.setFloat64(28, clampDelta(config.cryptoDelta), true);
  v.setFloat64(36, clampDelta(config.treasuriesDelta), true);
  v.setFloat64(44, clampDelta(config.corpBondsDelta), true);
  v.setBigUint64(52, BigInt(Date.now()) * 1_000_000n, true); // ms -> ns approx
  return buf;
}
