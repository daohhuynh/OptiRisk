// ============================================================================
// /api/stream — Server-Sent Events stream of binary backend frames.
//
// Each upstream WS frame from the C++ backend is forwarded to every
// connected SSE client as a base64-encoded `data:` line. The browser
// decodes it back to an ArrayBuffer and feeds the existing binary
// protocol decoder unchanged.
//
// Why SSE instead of a raw browser WebSocket:
//   * SSE rides on plain HTTP/1.1, which Next.js dev server, every CDN,
//     and every WSL2 / VPN port forwarder handles correctly.
//   * The browser only ever talks to its own origin (port 3000); there
//     is no second port to expose, no CORS, no mixed-content rule.
//   * The Node.js runtime inside Next.js connects to the C++ backend
//     locally over loopback — that hop is always reachable.
// ============================================================================

import { NextRequest } from 'next/server';
import { upstream } from '../../../lib/bridge/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch {
          closed = true;
        }
      };

      // Initial hello so EventSource flips to OPEN immediately.
      safeEnqueue(encoder.encode(`: hello\n\n`));

      const sink = (frame: Buffer) => {
        // SSE data frame — base64 keeps it textual & line-safe.
        const b64 = frame.toString('base64');
        safeEnqueue(encoder.encode(`data: ${b64}\n\n`));
      };

      upstream.addSink(sink);

      // Keepalive comment every 15 s — defeats proxy idle timeouts.
      const ka = setInterval(() => {
        safeEnqueue(encoder.encode(`: ka\n\n`));
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(ka);
        upstream.removeSink(sink);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Abort signal fires when the browser disconnects.
      _req.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
