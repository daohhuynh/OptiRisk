// ============================================================================
// shockCodec.ts — Single source of truth for the 60-byte ShockPayload frame.
//
// Layout (little-endian, matches backend wire_protocol.hpp):
//   [0..3]   header  : msg_type=0x01, _reserved=0, payload_len=56 (u16)
//   [4..7]   target_node_id (u32, 0xFFFFFFFF = market-wide)
//   [8..11]  shock_type (u32) — 0=custom, 1=lehman, 2=covid,
//                                3=rate_hike, 4=crypto_crash, 0xFF=reset
//   [12..19] equities      (f64 delta, e.g. -0.30 = "drop 30%")
//   [20..27] real_estate   (f64)
//   [28..35] crypto        (f64)
//   [36..43] treasuries    (f64)
//   [44..51] corp_bonds    (f64)
//   [52..59] timestamp_ns  (u64, ns since epoch)
// ============================================================================

export interface ShockSpec {
  target_node_id?: number;
  shock_type?: number;
  equities?: number;
  real_estate?: number;
  crypto?: number;
  treasuries?: number;
  corp_bonds?: number;
}

const HEADER_SIZE = 4;
const PAYLOAD_SIZE = 56;
const FRAME_SIZE = HEADER_SIZE + PAYLOAD_SIZE; // 60
const MSG_TYPE_SHOCK = 0x01;

function clampDelta(x: unknown): number {
  const n = typeof x === 'number' ? x : 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(-0.99, Math.min(0.99, n));
}

export function encodeShockFrame(spec: ShockSpec): ArrayBuffer {
  const buf = new ArrayBuffer(FRAME_SIZE);
  const v = new DataView(buf);

  v.setUint8(0, MSG_TYPE_SHOCK);
  v.setUint8(1, 0);
  v.setUint16(2, PAYLOAD_SIZE, true);

  const base = HEADER_SIZE;
  v.setUint32(base + 0, spec.target_node_id ?? 0xffffffff, true);
  v.setUint32(base + 4, spec.shock_type ?? 0, true);
  v.setFloat64(base + 8, clampDelta(spec.equities), true);
  v.setFloat64(base + 16, clampDelta(spec.real_estate), true);
  v.setFloat64(base + 24, clampDelta(spec.crypto), true);
  v.setFloat64(base + 32, clampDelta(spec.treasuries), true);
  v.setFloat64(base + 40, clampDelta(spec.corp_bonds), true);
  v.setBigUint64(base + 48, BigInt(Date.now()) * 1_000_000n, true);

  return buf;
}

export function encodeResetFrame(): ArrayBuffer {
  return encodeShockFrame({
    target_node_id: 0xffffffff,
    shock_type: 0xff,
  });
}

export function encodeShockBase64(spec: ShockSpec): string {
  return Buffer.from(encodeShockFrame(spec)).toString('base64');
}
