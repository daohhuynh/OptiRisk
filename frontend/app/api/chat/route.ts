import { NextResponse } from 'next/server';
import OpenAI from 'openai';

// Ensure OPENAI_API_KEY is available in the environment (.env.local)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Map string asset classes from the LLM down to their exact byte offsets 
// inside the 56-byte C++ ShockPayload struct.
// (Offset assumes a 4-byte MessageHeader prefixes the payload: 4 + 56 = 60 bytes total)
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

    // 1. OPENAI INTEGRATION & SEMANTIC ROUTING
    // We define a strict tool that forces the LLM to output predictable JSON for market shocks.
    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
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
    });

    const choice = response.choices[0];

    // 2. THE ROUTER LOGIC
    // If the LLM just wants to talk (e.g., "Can I trust Citadel?"), return the text directly to the UI.
    if (choice.message.content && (!choice.message.tool_calls || choice.message.tool_calls.length === 0)) {
      return NextResponse.json({ type: 'text', content: choice.message.content });
    }

    // 3. TOOL EXECUTION & JSON EXTRACTION
    if (choice.message.tool_calls) {
      const toolCall = choice.message.tool_calls.find(t => t.function.name === 'trigger_market_shock');
      
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

        // b. Pack the ShockPayload (56 bytes) starting at offset 4
        // target_node_id (0xFFFFFFFF = broadcast to all)
        view.setUint32(4, 0xFFFFFFFF, true);
        
        // shock_type (e.g., 0 = custom)
        view.setUint32(8, 0, true);

        // Apply the core shock to the requested asset class, leaving others at 0.0 (default via ArrayBuffer allocation)
        const targetOffset = ASSET_OFFSETS[args.asset_class];
        if (!targetOffset) {
          return NextResponse.json({ error: 'Invalid asset class specified by LLM' }, { status: 400 });
        }
        
        view.setFloat64(targetOffset, args.delta_percentage, true); // Little-Endian Float64

        // Pack the timestamp (monotonic clock) at the end of the Payload [52..59]
        const timestampNs = BigInt(Date.now()) * 1_000_000n;
        view.setBigUint64(52, timestampNs, true);

        // 5. WEBSOCKET EGRESS ARCHITECTURE (CRITICAL)
        // Encode the packed ArrayBuffer into a Base64 string to be returned to the client.
        // The Client Browser will decode this and send it down the persistent WebSocket.
        const base64Payload = Buffer.from(buffer).toString('base64');

        return NextResponse.json({
          type: 'binary_command',
          payload: base64Payload
        });
      }
    }

    return NextResponse.json({ error: 'Unknown LLM state' }, { status: 500 });
  } catch (error) {
    console.error('NLP Transpiler Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
