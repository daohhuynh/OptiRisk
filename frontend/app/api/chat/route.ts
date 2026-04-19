// ============================================================================
// /api/chat — natural-language → backend ShockPayload bridge
//
// Pipeline:
//   1. POST the user prompt to K2 Think v2 at
//        https://api.k2think.ai/v1/chat/completions
//      with our system prompt that asks the model to emit:
//        FN_CALL=True
//        trigger_market_shock(<arg>=<value>, ...)
//      We parse that block, pack the args into the C++ binary ShockPayload
//      (4-byte header + 56-byte body, little-endian) and return base64.
//   2. If K2 returns plain conversational text, surface it as chat output.
//   3. If K2 fails for any reason (no key, 4xx/5xx, parse error, timeout)
//      fall back to a local regex parser so the chatbox always does
//      something useful, even fully offline.
//
// Configuration (env, all optional with sensible defaults):
//   K2_API_KEY    – IFM- bearer token (without it we go straight to fallback)
//   K2_BASE_URL   – defaults to https://api.k2think.ai/v1
//   K2_MODEL      – defaults to MBZUAI-IFM/K2-Think-v2
// ============================================================================

import { NextResponse } from 'next/server';

// ── Wire constants (must match backend wire_protocol.hpp + frontend schema.ts)
const HEADER_SIZE = 4;
const PAYLOAD_SIZE = 56;
const MSG_TYPE_SHOCK = 0x01;

const ASSET_OFFSETS = {
  equities: 8,     // [8..15]   (offset within the 56-byte ShockPayload, NOT the 60-byte framed buffer)
  real_estate: 16, // [16..23]
  crypto: 24,      // [24..31]
  treasuries: 32,  // [32..39]
  corp_bonds: 40,  // [40..47]
} as const;

type AssetClass = keyof typeof ASSET_OFFSETS;

interface ShockSpec {
  target_node_id?: number;          // default 0xFFFFFFFF (market-wide)
  shock_type?: number;              // default 0 (custom)
  equities?: number;
  real_estate?: number;
  crypto?: number;
  treasuries?: number;
  corp_bonds?: number;
}

// Build the 60-byte framed buffer (header + ShockPayload), return base64.
function packShockBase64(spec: ShockSpec): string {
  const buf = new ArrayBuffer(HEADER_SIZE + PAYLOAD_SIZE);
  const v = new DataView(buf);

  // Header (4 bytes): msg_type, _reserved, payload_len (LE uint16)
  v.setUint8(0, MSG_TYPE_SHOCK);
  v.setUint8(1, 0);
  v.setUint16(2, PAYLOAD_SIZE, true);

  // Payload starts at offset 4 (HEADER_SIZE)
  const base = HEADER_SIZE;
  v.setUint32(base + 0, spec.target_node_id ?? 0xFFFFFFFF, true);
  v.setUint32(base + 4, spec.shock_type ?? 0, true);
  v.setFloat64(base + 8, spec.equities ?? 0, true);
  v.setFloat64(base + 16, spec.real_estate ?? 0, true);
  v.setFloat64(base + 24, spec.crypto ?? 0, true);
  v.setFloat64(base + 32, spec.treasuries ?? 0, true);
  v.setFloat64(base + 40, spec.corp_bonds ?? 0, true);
  // Timestamp (uint64 ns) at [48..55] of the payload  → buffer offset base+48
  v.setBigUint64(base + 48, BigInt(Date.now()) * 1_000_000n, true);

  return Buffer.from(buf).toString('base64');
}

// Clamp deltas into a sane range. ±0.99 keeps the SIMD math well-defined.
function clampDelta(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.max(-0.99, Math.min(0.99, x));
}

// ── Local regex fallback ───────────────────────────────────────────────────
//
// Recognised inputs (case-insensitive, magnitudes tolerant):
//   "crash equities by 30%"       → equities -0.30
//   "drop crypto 80"              → crypto   -0.80
//   "freeze 99% of all stocks"    → equities -0.95 (negative direction word)
//   "lehman 2008" / "covid 2020"  → preset
//   "rate hike"                   → preset
//   "crypto crash"                → preset
//   "+15 treasuries"              → treasuries +0.15
//
const NEGATIVE_WORDS = [
  'drop','down','fall','crash','sell','sold','lose','loss','haircut','negative',
  'freeze','frozen','halt','halted','kill','killed','wipe','wiped','nuke','nuked',
  'tank','tanked','dump','dumped','collapse','collapsed','implode','imploded',
  'meltdown','melt','crater','cratered','plunge','plunged','slash','slashed',
  'cut','burn','burned','destroy','destroyed','disable','disabled','suspend',
  'suspended','short','shorted','bust','busted','wreck','wrecked','panic',
  'liquidate','liquidated','stress','shock'
];
const POSITIVE_WORDS = [
  'rally','surge','rip','jump','boom','spike','pump','rise','rose','rising',
  'gain','gained','climb','climbed','pop','popped','moon','mooning','recover','recovered'
];

const ASSET_SYNONYMS: Record<AssetClass, string[]> = {
  equities:    ['equity','equities','stock','stocks','sp500','spx','nasdaq','dow','share','shares'],
  real_estate: ['real estate','realestate','reit','reits','housing','property','properties','mortgage','mortgages'],
  crypto:      ['crypto','bitcoin','btc','eth','ether','ethereum','altcoin','altcoins','token','tokens','digital asset','digital assets'],
  treasuries:  ['treasury','treasuries','tbill','tbills','t-bill','t-bills','tbond','tbonds','government bond','government bonds','sovereign'],
  corp_bonds:  ['corp bond','corp bonds','corporate bond','corporate bonds','credit','high yield','hy','investment grade','ig','junk'],
};

const SHOCK_PRESETS: Record<string, ShockSpec> = {
  lehman:      { equities: -0.40, real_estate: -0.25, crypto: 0,     treasuries: 0.05,  corp_bonds: -0.15, shock_type: 1 },
  covid:       { equities: -0.35, real_estate: -0.10, crypto: -0.50, treasuries: 0.08,  corp_bonds: -0.05, shock_type: 2 },
  ratehike:    { equities: -0.08, real_estate: -0.12, crypto: -0.20, treasuries: -0.20, corp_bonds: -0.12, shock_type: 3 },
  cryptocrash: { equities: -0.05, real_estate: 0,     crypto: -0.80, treasuries: 0.02,  corp_bonds: 0,     shock_type: 4 },
};

function tryParsePreset(text: string): ShockSpec | null {
  const t = text.toLowerCase();
  if (/lehman/.test(t))                      return SHOCK_PRESETS.lehman;
  if (/covid/.test(t))                       return SHOCK_PRESETS.covid;
  if (/rate.?hike|rate.?increase|fed.?hike/.test(t)) return SHOCK_PRESETS.ratehike;
  if (/crypto.?crash|crypto.?meltdown/.test(t))      return SHOCK_PRESETS.cryptocrash;
  return null;
}

function localFallbackParse(text: string): ShockSpec | null {
  const preset = tryParsePreset(text);
  if (preset) return preset;

  const t = ' ' + text.toLowerCase() + ' ';

  // Sign: any negative direction word forces a negative delta, even if the
  // user typed a bare positive number (the most common UI mistake).
  const hasNegWord = NEGATIVE_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(t));
  const hasPosWord = POSITIVE_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(t));
  const sign = hasNegWord ? -1 : hasPosWord ? +1 : -1; // default to negative — that's what people stress-test

  // Magnitude: first number we see, in {percent, decimal-fraction}.
  // Examples handled: "30", "30%", "0.3", "-0.3", ".30", "30 percent"
  const numMatch = t.match(/-?\d+(?:\.\d+)?/);
  let magnitude = 0;
  if (numMatch) {
    const raw = parseFloat(numMatch[0]);
    if (!isNaN(raw)) {
      const isPct = /%|percent/.test(t) || Math.abs(raw) > 1.5;
      magnitude = isPct ? Math.abs(raw) / 100 : Math.abs(raw);
    }
  }
  if (magnitude === 0) return null;

  // Asset class: first synonym match. If none, treat as market-wide.
  const matchedAssets: AssetClass[] = [];
  for (const [asset, syns] of Object.entries(ASSET_SYNONYMS) as [AssetClass, string[]][]) {
    if (syns.some(s => t.includes(s))) matchedAssets.push(asset);
  }
  const targetAssets: AssetClass[] = matchedAssets.length
    ? matchedAssets
    : ['equities','real_estate','crypto','treasuries','corp_bonds'];

  const out: ShockSpec = { shock_type: 0 };
  const delta = clampDelta(sign * magnitude);
  for (const a of targetAssets) (out as any)[a] = delta;
  return out;
}

// ── K2 Think call ──────────────────────────────────────────────────────────
//
// K2 Think v2 exposes a /chat/completions endpoint with a Bearer token, but
// it does NOT use a structured tool-call schema. Instead, when its system
// prompt asks it to "call a function", it emits a textual block of the form:
//
//   FN_CALL=True
//   trigger_market_shock(crypto=-80, equities=-15)
//
// We parse that block out of the assistant's reply. If it isn't there, we
// treat the response as plain conversational text.
//

// Per-asset numeric arguments accepted from the K2 textual function call.
const ASSET_KEYS = [
  'equities', 'real_estate', 'crypto', 'treasuries', 'corp_bonds',
] as const;

function magnitudeToFraction(raw: number): number {
  // K2 tends to emit percentages ("crypto=-80") rather than decimals
  // ("crypto=-0.80"). Heuristic: anything with |x| > 1.5 is interpreted
  // as a percent; smaller values are treated as already-fractional.
  if (!Number.isFinite(raw)) return 0;
  const sign = raw < 0 ? -1 : 1;
  const mag  = Math.abs(raw);
  const frac = mag > 1.5 ? mag / 100 : mag;
  return clampDelta(sign * frac);
}

// Strip K2-Think's chain-of-thought scaffolding from a raw response.
// K2 emits its reasoning either inside <think>…</think> tags OR as a long
// preamble that ends with a stray `</think>` followed by the real answer.
// We always prefer text *after* the last `</think>` if one is present.
function stripK2Reasoning(raw: string): string {
  const closeTag = raw.lastIndexOf('</think>');
  if (closeTag >= 0) return raw.slice(closeTag + '</think>'.length).trim();
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

function parseK2FunctionCall(content: string): ShockSpec | null {
  const cleaned = stripK2Reasoning(content);

  // K2 often quotes the prompt template literally before producing the
  // real call. Walk every `trigger_market_shock(...)` match and keep the
  // LAST one that yields a valid asset-class delta.
  const callRe = /trigger_market_shock\s*\(([^)]*)\)/gi;
  let bestSpec: ShockSpec | null = null;
  let m: RegExpExecArray | null;

  while ((m = callRe.exec(cleaned)) !== null) {
    const argString = m[1].trim();
    const spec: ShockSpec = { shock_type: 0 };

    for (const piece of argString.split(',')) {
      const eq = piece.indexOf('=');
      if (eq < 0) continue;
      const key = piece.slice(0, eq).trim().toLowerCase();
      const valRaw = piece.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      const num = parseFloat(valRaw);
      if (Number.isNaN(num)) continue;

      if (key === 'shock_type') {
        spec.shock_type = Math.max(0, Math.min(4, Math.round(num)));
      } else if (key === 'target_node_id') {
        spec.target_node_id = num >>> 0;
      } else if ((ASSET_KEYS as readonly string[]).includes(key)) {
        (spec as Record<string, number>)[key] = magnitudeToFraction(num);
      }
    }

    const anyAsset = ASSET_KEYS.some(
      k => typeof spec[k] === 'number' && spec[k] !== 0,
    );
    const hasPreset =
      typeof spec.shock_type === 'number' && spec.shock_type !== 0;
    if (anyAsset || hasPreset) bestSpec = spec;
  }

  return bestSpec;
}

// Map K2-emitted preset shock_type values back to concrete per-asset deltas
// (matches frontend SHOCK_PRESETS). K2 sometimes returns just shock_type=N
// with no asset args.
const PRESET_DELTAS: Record<number, Partial<ShockSpec>> = {
  1: { equities: -0.40, real_estate: -0.25, crypto: 0,     treasuries: 0.05,  corp_bonds: -0.15 }, // lehman
  2: { equities: -0.35, real_estate: -0.10, crypto: -0.50, treasuries: 0.08,  corp_bonds: -0.05 }, // covid
  3: { equities: -0.08, real_estate: -0.12, crypto: -0.20, treasuries: -0.20, corp_bonds: -0.12 }, // rate hike
  4: { equities: -0.05, real_estate: 0,     crypto: -0.80, treasuries: 0.02,  corp_bonds: 0     }, // crypto crash
};

function applyPresetIfBare(spec: ShockSpec): ShockSpec {
  const anyAsset = ASSET_KEYS.some(
    k => typeof spec[k] === 'number' && spec[k] !== 0,
  );
  if (anyAsset) return spec;
  const preset = spec.shock_type ? PRESET_DELTAS[spec.shock_type] : undefined;
  return preset ? { ...spec, ...preset } : spec;
}

async function callK2(messages: Array<{ role: string; content: string }>): Promise<
  | { kind: 'tool'; spec: ShockSpec }
  | { kind: 'text'; content: string }
  | { kind: 'fail'; reason: string }
> {
  const apiKey = process.env.K2_API_KEY;
  if (!apiKey) return { kind: 'fail', reason: 'no_api_key' };

  const baseURL = process.env.K2_BASE_URL || 'https://api.k2think.ai/v1';
  const model   = process.env.K2_MODEL    || 'MBZUAI-IFM/K2-Think-v2';

  const systemPrompt = [
    'You are the Chief Risk Officer AI for a Tier-1 prime brokerage running OptiRisk,',
    'a real-time counterparty risk simulator with 500 firms across 5 global hubs',
    '(NYC, London, Tokyo, Hong Kong, Dubai). The user types short market-shock',
    'scenarios at you and you translate them into structured shocks.',
    '',
    'OUTPUT FORMAT — when the user describes ANY price-moving event you MUST',
    'reply with EXACTLY two lines and nothing else:',
    '',
    '  FN_CALL=True',
    '  trigger_market_shock(<arg>=<value>, ...)',
    '',
    'Valid args: equities, real_estate, crypto, treasuries, corp_bonds (each a',
    'percentage delta as a number, e.g. -80 for a 80% drop), and an optional',
    'shock_type (0=custom, 1=lehman2008, 2=covid2020, 3=rate_hike, 4=crypto_crash).',
    'Omit any asset class you are not shocking. Do NOT include units, % signs,',
    'comments, code fences, or any other text.',
    '',
    'SIGN CONVENTION (critical):',
    '  • Negative direction words — crash, drop, fall, freeze, halt, kill,',
    '    wipe, nuke, tank, dump, collapse, plunge, slash, destroy, suspend,',
    '    disable, haircut, meltdown — ALWAYS map to NEGATIVE numbers.',
    '  • "freeze 99% of all stocks"  →  equities=-95 (suppression = price falls).',
    '  • "rally crypto 30%"          →  crypto=30.',
    '  • Default to negative when ambiguous — users almost always stress-test.',
    '',
    'MAGNITUDE: trust the user. "80%" → 80, "drop crypto 50" → -50. Do not',
    'water down extreme scenarios; the simulator handles them.',
    '',
    'If the user asks a QUESTION rather than describing a shock, respond with',
    'a single short sentence of plain English (no FN_CALL block).',
  ].join('\n');

  const body = {
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    temperature: 0.1,
    // K2-Think is a reasoning model: it uses a lot of completion tokens on
    // internal chain-of-thought before producing the FN_CALL line. 1024 is
    // enough headroom for any single shock parse.
    max_tokens: 1024,
  };

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { kind: 'fail', reason: `http_${res.status}` };
    }
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.length === 0) {
      return { kind: 'fail', reason: 'empty_response' };
    }

    // Try to extract a structured trigger_market_shock(...) call first.
    const spec = parseK2FunctionCall(text);
    if (spec) return { kind: 'tool', spec: applyPresetIfBare(spec) };

    // Otherwise treat it as conversational text — but always strip the
    // chain-of-thought scaffolding before exposing it to the user.
    const visible = stripK2Reasoning(text);
    return { kind: 'text', content: visible || text };
  } catch (e: unknown) {
    return { kind: 'fail', reason: (e as Error)?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const lastUserMsg = [...messages].reverse().find((m: { role?: string }) => m?.role === 'user');
    const userText: string = typeof lastUserMsg?.content === 'string' ? lastUserMsg.content : '';

    // 1. Local regex parse FIRST. Deterministic, sub-millisecond, and
    //    crucially: K2 often answers shock prompts with a *description*
    //    instead of the FN_CALL block we asked for ("an 89% stock crash
    //    would cause..."). Whenever a prompt has clear shock semantics,
    //    we want to fire the simulation immediately, not lecture the user.
    const local = localFallbackParse(userText);
    if (local) {
      return NextResponse.json({
        type: 'binary_command',
        payload: packShockBase64(local),
        spec: local,
        source: 'local_fallback',
      });
    }

    // 2. No clear shock — let K2 try. It may emit a structured FN_CALL,
    //    or just answer a question conversationally.
    const k2 = await callK2(messages);
    if (k2.kind === 'tool') {
      return NextResponse.json({
        type: 'binary_command',
        payload: packShockBase64(k2.spec),
        spec: k2.spec,
        source: 'k2',
      });
    }
    if (k2.kind === 'text') {
      return NextResponse.json({ type: 'text', content: k2.content, source: 'k2' });
    }

    return NextResponse.json({
      type: 'text',
      content: `Couldn't parse "${userText}". Try: "crash crypto by 80%", "lehman 2008", "freeze 99% of stocks".`,
      source: 'local_fallback',
      note: `K2 unavailable (${k2.reason}).`,
    });
  } catch (err: unknown) {
    console.error('[chat] route error:', err);
    return NextResponse.json(
      { error: (err as Error)?.message ?? 'unknown' },
      { status: 500 },
    );
  }
}
