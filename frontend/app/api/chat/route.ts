import { NextResponse } from 'next/server';
import OpenAI from 'openai';

// ── Updated to match sponsor email ──────────────────────────────────────────
function makeK2Client() {
  const apiKey = process.env.K2_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.k2think.ai/v1',
  });
}

const ASSET_OFFSETS = {
  equities: 12, real_estate: 20, crypto: 28, treasuries: 36, corp_bonds: 44,
};

const ASSET_ALIASES: Array<[RegExp, keyof typeof ASSET_OFFSETS]> = [
  [/\b(equities|equity|stocks?|spx|s&p|nasdaq)\b/i, 'equities'],
  [/\b(real[\s_-]?estate|property|housing|reit)\b/i, 'real_estate'],
  [/\b(crypto|bitcoin|btc|eth|ethereum)\b/i, 'crypto'],
  [/\b(treasur(?:y|ies)|rates?|duration|bonds?)\b/i, 'treasuries'],
  [/\b(corp(?:orate)?[\s_-]?bonds?|credit|ig|high[\s_-]?yield|hy)\b/i, 'corp_bonds'],
];

function normalizeDelta(raw: number): number {
  const scaled = Math.abs(raw) > 1 ? raw / 100 : raw;
  if (!Number.isFinite(scaled)) return 0;
  return Math.max(-0.95, Math.min(0.95, scaled));
}

function makeShockPayload(assetClass: keyof typeof ASSET_OFFSETS, delta: number, shockType = 0): string {
  const buffer = new ArrayBuffer(60);
  const view = new DataView(buffer);
  view.setUint8(0, 0x01);
  view.setUint8(1, 0);
  view.setUint16(2, 56, true);
  view.setUint32(4, 0xFFFFFFFF, true);
  view.setUint32(8, shockType, true);
  view.setFloat64(ASSET_OFFSETS[assetClass], normalizeDelta(delta), true);
  view.setBigUint64(52, BigInt(Date.now()) * 1_000_000n, true);
  return Buffer.from(buffer).toString('base64');
}

function localCommandFallback(content: string) {
  const asset = ASSET_ALIASES.find(([pattern]) => pattern.test(content))?.[1] ?? 'equities';
  const numberMatch = content.match(/[-+]?\d+(?:\.\d+)?\s*%/);
  const lower = content.toLowerCase();
  const scenario = /\b(lehman|2008|gfc|financial crisis)\b/.test(lower)
    ? { asset: 'equities' as const, delta: -40, shockType: 1 }
    : /\b(covid|pandemic|lockdown)\b/.test(lower)
      ? { asset: 'equities' as const, delta: -35, shockType: 2 }
      : /\b(rate|rates|hike|treasur(?:y|ies)|duration)\b/.test(lower)
        ? { asset: 'treasuries' as const, delta: -20, shockType: 3 }
        : /\b(crypto|bitcoin|btc|eth|ethereum).*\b(crash|crashes|crashed|collapse|collapses|meltdown|tanks?)\b|\b(crash|crashes|crashed|collapse|collapses|meltdown|tanks?)\b.*\b(crypto|bitcoin|btc|eth|ethereum)\b/.test(lower)
          ? { asset: 'crypto' as const, delta: -80, shockType: 4 }
          : null;
  const parsed = scenario ? scenario.delta : numberMatch ? Number.parseFloat(numberMatch[0]) : -10;
  const asksForDrop = /\b(drop|down|fall|crash|sell|stress|shock|lose|loss|haircut|negative)\b/i.test(content);
  const signed = parsed > 0 && asksForDrop ? -parsed : parsed;
  const selectedAsset = scenario?.asset ?? asset;

  return {
    type: 'binary_command',
    payload: makeShockPayload(selectedAsset, signed, scenario?.shockType ?? 0),
    source: 'local_regex_fallback',
  };
}

export async function POST(req: Request) {
  let userContent = '';
  try {
    const { messages } = await req.json();
    userContent = messages?.at(-1)?.content ?? '';
    const openai = makeK2Client();
    if (!openai) {
      return NextResponse.json(localCommandFallback(userContent));
    }

    const response = await openai.chat.completions.create({
      model: 'MBZUAI-IFM/K2-Think-v2', // Exact model string from email
      messages: [
        {
          role: 'system',
          content: 'You are the Chief Risk Officer. If a user suggests a market shock, use the trigger_market_shock tool.'
        },
        ...messages
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'trigger_market_shock',
            description: 'Trigger a financial shock.',
            parameters: {
              type: 'object',
              properties: {
                asset_class: {
                  type: 'string',
                  enum: ['equities', 'real_estate', 'crypto', 'treasuries', 'corp_bonds']
                },
                delta_percentage: { type: 'number' }
              },
              required: ['asset_class', 'delta_percentage']
            }
          }
        }
      ],
      tool_choice: 'auto',
    });

    const choice = response.choices[0];

    // Handle Tool Call (The Binary Trigger)
    if (choice.message.tool_calls) {
      const toolCall = choice.message.tool_calls.find((call) => call.type === 'function');
      if (!toolCall) {
        return NextResponse.json(localCommandFallback(userContent));
      }
      const args = JSON.parse(toolCall.function.arguments);

      const targetOffset = ASSET_OFFSETS[args.asset_class as keyof typeof ASSET_OFFSETS];
      if (targetOffset === undefined) {
        return NextResponse.json(localCommandFallback(userContent));
      }

      const base64Payload = makeShockPayload(
        args.asset_class as keyof typeof ASSET_OFFSETS,
        Number(args.delta_percentage),
      );
      return NextResponse.json({ type: 'binary_command', payload: base64Payload, source: 'k2' });
    }

    // Handle standard text response
    return NextResponse.json({ type: 'text', content: choice.message.content });

  } catch (error: any) {
    console.error('K2 API ERROR:', error.message);
    return NextResponse.json(localCommandFallback(userContent));
  }
}
