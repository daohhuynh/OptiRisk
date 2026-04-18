import { NextResponse } from 'next/server';
// ── K2 Think V2 Configuration ───────────────────────────────────────────────
// We utilize native Node.js fetch to securely hit the K2 inference engine
// bypassing the OpenAI SDK entirely as requested.
const K2_BASE_URL = 'https://api.k2.ai/v1/chat/completions';

// Map string asset classes from the LLM down to their exact byte offsets 
// inside the 56-byte C++ ShockPayload struct.
// (4-byte MessageHeader prefix means payload starts at offset 4)
const ASSET_OFFSETS = {
  equities: 12,    // [12..19]
  real_estate: 20, // [20..27]
  crypto: 28,      // [28..35]
  treasuries: 36,  // [36..43]
  corp_bonds: 44,  // [44..51]
};

export async function POST(req: Request) {
  try {
    const { messages } = await req.json();

    // 1. SEMANTIC ROUTING via K2 Think V2
    const k2Response = await fetch(K2_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.K2_API_KEY}`
      },
      body: JSON.stringify({
        model: 'k2', // Target the K2 model directly
        messages: [
          {
            role: 'system',
            content: 'You are the Chief Risk Officer AI for a Tier-1 Prime Brokerage. Be helpful. If the user asks for a market visualization or shock scenario, ALWAYS use the trigger_market_shock tool.'
          },
          ...messages
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'trigger_market_shock',
              description: 'Trigger a localized financial market shock and observe systemic risk contagions.',
              parameters: {
                type: 'object',
                properties: {
                  asset_class: {
                    type: 'string',
                    enum: ['equities', 'real_estate', 'crypto', 'treasuries', 'corp_bonds']
                  },
                  delta_percentage: {
                    type: 'number',
                    description: 'Fractional change, e.g. 0.10 for +10%, -0.20 for -20%'
                  }
                },
                required: ['asset_class', 'delta_percentage']
              }
            }
          }
        ],
        tool_choice: 'auto',
      })
    });

    if (!k2Response.ok) {
      throw new Error(`K2 API Error: ${k2Response.statusText}`);
    }

    const response = await k2Response.json();

    const choice = response.choices[0];

    // 2. CONVERSATIONAL FALLBACK
    // If the LLM just wants to talk (e.g., "Can I trust Citadel?"), return text
    if (choice.message.content && (!choice.message.tool_calls || choice.message.tool_calls.length === 0)) {
      return NextResponse.json({ type: 'text', content: choice.message.content });
    }

    // 3. TOOL EXECUTION & JSON EXTRACTION
    if (choice.message.tool_calls) {
      // Direct raw API responses map tool_calls a bit differently than the SDK wrapper sometimes
      const toolCall = choice.message.tool_calls.find((t: any) => t.function.name === 'trigger_market_shock');

      if (toolCall) {
        const args = JSON.parse(toolCall.function.arguments) as {
          asset_class: keyof typeof ASSET_OFFSETS;
          delta_percentage: number;
        };

        // 4. THE BINARY TRANSPILER & DATAVIEW PACKING
        // We pack [ 4 bytes Header ] + [ 56 bytes Payload ] = 60 bytes total
        const buffer = new ArrayBuffer(60);
        const view = new DataView(buffer);

        // a. Pack the MessageHeader (4 bytes)
        view.setUint8(0, 0x01); // MsgType::ShockPayload = 0x01
        view.setUint8(1, 0x00); // Reserved
        view.setUint16(2, 56, true); // Payload Length = 56 (Little-Endian)

        // b. Pack the ShockPayload (56 bytes)
        // target_node_id (0xFFFFFFFF = broadcast to all)
        view.setUint32(4, 0xFFFFFFFF, true);

        // shock_type (e.g., 0 = custom)
        view.setUint32(8, 0, true);

        // Apply dynamic float exposure mapping 
        const targetOffset = ASSET_OFFSETS[args.asset_class];
        if (!targetOffset) {
          return NextResponse.json({ error: 'Invalid asset class specified by K2' }, { status: 400 });
        }

        // Write the delta as a Float64 (Little-Endian) at the exact requested offset
        view.setFloat64(targetOffset, args.delta_percentage, true);

        // Pack the timestamp (monotonic clock) at the end [52..59]
        const timestampNs = BigInt(Date.now()) * 1_000_000n;
        view.setBigUint64(52, timestampNs, true);

        // 5. WEBSOCKET EGRESS ARCHITECTURE (CRITICAL)
        // We do NOT open a WebSocket here. We encode the raw memory buffer as Base64.
        const base64Payload = Buffer.from(buffer).toString('base64');

        return NextResponse.json({
          type: 'binary_command',
          payload: base64Payload
        });
      }
    }

    return NextResponse.json({ error: 'Unknown LLM state' }, { status: 500 });
  } catch (error) {
    console.error('K2 Transpiler Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
