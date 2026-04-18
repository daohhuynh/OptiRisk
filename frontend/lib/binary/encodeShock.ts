import type { ShockConfig } from '@/types/simulation';
import { SHOCK_PAYLOAD_SIZE } from './schema';

const SHOCK_TYPE_WIRE: Record<string, number> = {
  custom: 0, lehman2008: 1, covid2020: 2, rate_hike: 3, crypto_crash: 4,
};

export function encodeShockPayload(config: ShockConfig): ArrayBuffer {
  const buf = new ArrayBuffer(SHOCK_PAYLOAD_SIZE);
  const v = new DataView(buf);
  v.setUint32(0, config.targetNodeId, true);
  v.setUint32(4, SHOCK_TYPE_WIRE[config.shockType] ?? 0, true);
  v.setFloat64(8,  config.equitiesDelta, true);
  v.setFloat64(16, config.realEstateDelta, true);
  v.setFloat64(24, config.cryptoDelta, true);
  v.setFloat64(32, config.treasuriesDelta, true);
  v.setFloat64(40, config.corpBondsDelta, true);
  v.setBigUint64(48, BigInt(Date.now()) * 1_000_000n, true); // ms → ns approx
  return buf;
}
