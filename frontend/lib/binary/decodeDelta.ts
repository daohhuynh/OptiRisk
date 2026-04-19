import type { TickDeltaMsg, VaRReportMsg, MarketAnchorsMsg } from '@/types/simulation';
import { MSG_HEADER_SIZE, MsgType, TICK_DELTA_SIZE, VAR_REPORT_SIZE, MARKET_ANCHORS_SIZE } from './schema';

export function parseMessageType(buf: ArrayBuffer): number {
  if (buf.byteLength < MSG_HEADER_SIZE) return -1;
  const view = new DataView(buf);
  return view.getUint8(0);
}

export function decodeTickDelta(buf: ArrayBuffer, offset = MSG_HEADER_SIZE): TickDeltaMsg | null {
  if (buf.byteLength < offset + TICK_DELTA_SIZE) return null;
  const v = new DataView(buf, offset);
  return {
    nodeId: v.getUint32(0, true),
    riskScore: v.getFloat32(4, true),
    nav: v.getFloat64(8, true),
    exposureTotal: v.getFloat64(16, true),
    deltaNAV: v.getFloat64(24, true),
    deltaExposure: v.getFloat64(32, true),
    isDefaulted: v.getUint8(40) === 1,
    hubId: v.getUint8(41),
    cascadeDepth: v.getUint8(42),
    tickSeq: v.getUint32(44, true),
    computeCycles: v.getBigUint64(48, true),
  };
}

export function decodeVaRReport(buf: ArrayBuffer): VaRReportMsg | null {
  // Header is 4 bytes. Payload is 56 bytes.
  if (buf.byteLength < 60) return null;

  const view = new DataView(buf);

  // Start reading at offset 4 (skipping the MessageHeader)
  const targetNode = view.getUint32(4, true);
  const pathsRun = view.getUint32(8, true);
  const var95 = view.getFloat64(12, true);

  // Extract the 16-bucket empirical distribution (uint16_t)
  const buckets: number[] = [];
  for (let i = 0; i < 16; i++) {
    // 20 is the offset after var_95. Each bucket is 2 bytes.
    buckets.push(view.getUint16(20 + (i * 2), true));
  }

  // Extract expected loss at the final 8 bytes
  const expectedLoss = view.getFloat64(52, true);

  return { targetNode, pathsRun, var95, buckets, expectedLoss };
}

export function decodeMarketAnchors(buf: ArrayBuffer, offset = MSG_HEADER_SIZE): MarketAnchorsMsg | null {
  if (buf.byteLength < offset + MARKET_ANCHORS_SIZE) return null;
  const v = new DataView(buf, offset);
  return {
    equities: v.getFloat64(0, true),
    realEstate: v.getFloat64(8, true),
    crypto: v.getFloat64(16, true),
    treasuries: v.getFloat64(24, true),
    corpBonds: v.getFloat64(32, true),
  };
}
