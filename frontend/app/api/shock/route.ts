// ============================================================================
// /api/shock — Browser → backend shock injection.
//
// Accepts either:
//   { spec: { equities: -0.3, ... } }   → server encodes the 60-byte frame
//   { base64: "..." }                   → caller (chat route) already encoded
//   { reset: true }                     → emits magic shock_type=0xFF
//
// Sends the frame via the singleton upstream WebSocket bridge.
// Returns 200 on success, 503 if backend is unreachable.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server';
import { upstream } from '../../../lib/bridge/upstream';
import {
  encodeShockFrame,
  encodeResetFrame,
  type ShockSpec,
} from '../../../lib/bridge/shockCodec';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ShockRequest {
  spec?: ShockSpec;
  base64?: string;
  reset?: boolean;
}

export async function POST(req: NextRequest) {
  let body: ShockRequest;
  try {
    body = (await req.json()) as ShockRequest;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  let frame: ArrayBuffer;
  if (body.reset) {
    frame = encodeResetFrame();
  } else if (body.base64) {
    const buf = Buffer.from(body.base64, 'base64');
    frame = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } else if (body.spec) {
    frame = encodeShockFrame(body.spec);
  } else {
    return NextResponse.json({ ok: false, error: 'missing_payload' }, { status: 400 });
  }

  const ok = await upstream.sendWhenReady(frame, 2000);
  if (!ok) {
    return NextResponse.json(
      { ok: false, error: 'upstream_not_connected', status: upstream.status },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true, bytes: frame.byteLength });
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    upstream: upstream.status,
    alive: upstream.isAlive(),
  });
}
