import { NextResponse } from 'next/server';
import OpenAI from 'openai';

// ── K2 Think V2 Configuration ───────────────────────────────────────────────
// We use the OpenAI SDK as a proxy to hit the K2 inference engine.
const openai = new OpenAI({
  apiKey: process.env.K2_API_KEY,
  baseURL: 'https://api.k2.ai/v1', // This forces all traffic to MBZUAI
});

// Map asset classes to exact byte offsets in the 56-byte C++ ShockPayload struct.
// Header (4 bytes) + Payload (56 bytes) = 60 bytes total.
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
    // We use Structured Outputs (tools) to force the model into a strict JSON format.
    const response = await openai.chat.completions.create({
      model: 'k2',
      messages: [
        {
          role: 'system',
          content: 'You are the Chief Risk Officer AI for a Tier-1 Prime Brokerage. If the user asks for a market shock or scenario, use the trigger_market_shock tool.'
        },
        ...messages
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'trigger_market_shock',
            description: 'Trigger a localized financial market shock.',
            parameters: {
              type: 'object',
              properties: {
                asset_class: {
                  type: 'string',
                  enum: ['equities', 'real_estate', 'crypto', 'treasuries', 'corp_bonds']
                },
                delta_percentage: {
                  type: 'number',
                  description: 'Change as a decimal, e.g. -0.15 for a 15% drop.'
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

    // 2. CONVERSATIONAL FALLBACK (Text response)
    if (choice.message.content && (!choice.message.tool_calls || choice.message.tool_calls.length === 0)) {
      return NextResponse.json({ type: 'text', content: choice.message.content });
    }

    // 3. TOOL EXECUTION & BINARY PACKING
    if (choice.message.tool_calls) {
      const toolCall = choice.message.tool_calls[0]; // Take the first call
      const args = JSON.parse(toolCall.function.arguments);

      // Create 60-byte buffer (4 byte header + 56 byte payload)
      const buffer = new ArrayBuffer(60);
      const view = new DataView(buffer);

      // --- a. MessageHeader (4 bytes) ---
      view.setUint8(0, 0x01);      // MsgType::ShockPayload
      view.setUint8(1, 0x00);      // Reserved
      view.setUint16(2, 56, true); // Payload length 56 (Little-Endian)

      // --- b. ShockPayload (56 bytes) ---
      view.setUint32(4, 0xFFFFFFFF, true); // target_node_id (Broadcast)
      view.setUint32(8, 0, true);          // shock_type (Default)

      // Apply shock to the correct offset based on LLM's chosen asset
      const targetOffset = ASSET_OFFSETS[args.asset_class as keyof typeof ASSET_OFFSETS];
      view.setFloat64(targetOffset, args.delta_percentage, true);

      // Timestamp at the end [52..59]
      const timestampNs = BigInt(Date.now()) * 1_000_000n;
      view.setBigUint64(52, timestampNs, true);

      // 4. EGRESS
      const base64Payload = Buffer.from(buffer).toString('base64');
      return NextResponse.json({ type: 'binary_command', payload: base64Payload });
    }

    return NextResponse.json({ error: 'Incomplete LLM response' }, { status: 500 });

  } catch (error) {
    console.error('K2 Route Error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}