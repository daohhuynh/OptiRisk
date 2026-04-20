# OptiRisk

**Real-time counterparty risk simulation at HFT speeds.**

OptiRisk is a high-performance counterparty credit-risk engine that models cascading default propagation across a 500-node financial network — and visualizes it live on a dark, Obsidian-inspired geographic map. Trigger a shock at any institution and watch the failure ripple through every counterparty connected to it.

Built like a tiny trading system: a bare-metal **C++23 risk engine** on the backend, a **Next.js + WebGL** frontend, and a strict **binary wire contract** between them.

---

## Architecture Overview

```
[ User clicks "shock NYC bank" ]
            │
            ▼
  Next.js  POST /api/shock  ──►  C++ Backend (port 8080)
                                   ├─ Thread 1: Network listener   (core 1)
                                   ├─ Thread 2: Risk compute       (core 2)
                                   └─ Thread 3: Broadcast publisher (core 3)
                                           │ binary frames
                                           ▼
              C++ ───►  Next.js /api/stream (SSE)  ───►  Browser
                                                          │
                                            decode binary │
                                                          ▼
                                          Zustand stores → deck.gl + MapLibre
```

Everything between the C++ engine and the browser is **binary structs**, not JSON. JSON appears only at the chat / control layer.

---

## Backend — the "trading floor in a box"

Located in `backend/src/`. C++23, no exceptions, no heap on the hot path.

### Three pinned threads, no locks

`backend/src/main.cpp` boots three `std::thread`s, each `pin_thread_to_core()`'d to its own CPU core. They communicate through an **LMAX Disruptor** lock-free ring buffer (see `concurrency/disruptor.hpp`). No `mutex`, no `condition_variable` — coordination is done with `std::atomic` cursors and explicit memory ordering.

| Thread | Core | Job |
|--------|------|-----|
| Network  | 1 | uWS listener; parses incoming binary `ShockPayload` frames into `shock_ring` |
| Compute  | 2 | Drains `shock_ring`, runs the cascade physics, writes per-node `TickDelta`s into `tick_ring` |
| Broadcast | 3 | Drains `tick_ring`, fans `TickDelta`s out over WebSocket (TCP) and UDP multicast |

### The graph is one big stack-allocated struct

`memory/csr_graph.hpp` stores 500 nodes and up to 8 192 edges in **CSR (Compressed Sparse Row)** format using `std::array`. Layout is **Struct-of-Arrays**: every `risk_score` is in one contiguous block, every `nav` in another, etc. The hot loop streams one cache line at a time — pure sequential prefetch. The whole graph lives in `.bss` and is zero-initialized at startup.

### The cascade loop

`compute/cascade_engine.hpp` is the actual contagion physics: who defaults this round, whose balance sheet that hurts, do *they* default, repeat until quiescent. Supporting modules:

- `compute/monte_carlo.hpp` — VaR for the "hero firm"
- `compute/simd_engine.hpp` / `compute/black_scholes_simd.hpp` — AVX2 / FMA3 vectorized math
- `market/order_book.hpp` — CLOB used to price liquidations with realistic slippage
- `memory/options_book.hpp` — option exposure book

### Auto-tick playback

After every real shock, the compute thread keeps ticking the system every 100 ms with a no-op shock until the market has been quiet for 20 consecutive ticks. This is what turns the cascade into a *visible spreading wave* on the frontend instead of a single instant equilibrium snap. A real shock arriving on the ring breaks out immediately.

### Binary wire protocol

`network/wire_protocol.hpp` defines packed structs (`TickDelta`, `VaRReport`, `MarketAnchors`, `ShockPayload`, …). They are serialized with `memcpy` directly into WebSocket frames — no JSON, no Protobuf, no allocator on the hot path.

### Zero-allocation guarantees

Enforced project-wide on the hot path: no `new`/`delete`, no `vector`/`string`/`map`, no `virtual`, no `regex`, no `stringstream`. Strings are interned to `enum class` / `uint32_t` IDs at the I/O boundary. Shared structs are `alignas(64)` to defeat false sharing. See `CLAUDE.md` for the full constraint list.

---

## Frontend — the cinematic map

Located in `frontend/`. Next.js 15 (App Router) + TypeScript + Tailwind. The design/architecture bible is `frontend/CLAUDE.md`.

### Rendering stack

- **MapLibre** — dark basemap providing geographic context
- **deck.gl** — GPU-accelerated layers on top of the map (nodes, edges, labels, hub blobs, focus highlights). See `components/map/layers/`.
- **React** — manages app structure only; it never re-renders the graph itself.

> Note: this project uses MapLibre + deck.gl, **not** React Three Fiber. The graph is a geo graph, not a free-floating force graph.

### State = Zustand stores, split by concern (`frontend/store/`)

| Store | Responsibility |
|-------|----------------|
| `connectionStore.ts` | WebSocket / SSE status, last message time |
| `graphStore.ts`      | Nodes, edges, which entities changed this tick |
| `simulationStore.ts` | Phase (`pre_shock` → `shock_triggered` → `cascade_running` → `cascade_complete`), current tick, event log, VaR report |
| `uiStore.ts`         | Hovered node, selected node, focused city |

### Transport: SSE, not raw browser WebSocket

The browser does **not** talk to C++ directly. Instead:

1. `frontend/services/websocket.ts` opens an `EventSource('/api/stream')`.
2. `frontend/app/api/stream/route.ts` (a Next.js Node route) holds the real WebSocket to the C++ backend on `localhost:8080` and base64-forwards each binary frame as an SSE `data:` line.
3. `frontend/lib/binary/decodeDelta.ts` decodes those bytes back into typed objects via `DataView`.

Why this dance? SSE rides on plain HTTP/1.1, which Next.js dev server, every CDN, and every WSL2 / VPN port forwarder handles correctly. No CORS, no second port to expose, no mixed-content rules.

Outbound shocks take the symmetric path: the browser POSTs a base64-encoded `ShockPayload` to `/api/shock`, which forwards it to the C++ engine over the same upstream WebSocket.

### Display pacing

The backend ticks at ~10 Hz, which would make the cascade finish in <1 second — too fast for a human to follow. So `websocket.ts` buffers incoming `TickDelta`s **grouped by `tick_seq`** and drains one batch every 400 ms. The backend keeps computing at full speed; the user sees a wave.

### The chat / AI layer

`frontend/app/api/chat/route.ts` accepts natural-language prompts ("simulate a 2008-style collapse on JPMorgan"), sends them to an LLM that emits a structured `trigger_market_shock(...)` call, packs the result into the C++ binary `ShockPayload`, and POSTs it to `/api/shock`. If the LLM is unavailable, a local regex parser keeps the chatbox usable fully offline.

### UI shell

`app/page.tsx` is short and tells the whole story: full-screen `<MapContainer />` underneath, with floating HUD panels — `TopControls`, `NodeInfoCard` / `CityHubPanel`, `ChatPanel`, `StatusBar`. Dark, Obsidian-inspired aesthetic, all Tailwind.

---

## The key seam: one binary contract, two languages

`network/wire_protocol.hpp` (C++) and `lib/binary/schema.ts` + `lib/binary/decodeDelta.ts` (TypeScript) describe the **exact same bytes**. Change one, you must change the other. Field offsets, sizes, and message-type enums are kept in lock-step.

```text
TickDelta       = 56 bytes   MsgType 0x02
VaRReport       = 16 bytes   MsgType 0x07
MarketAnchors   = 40 bytes   MsgType 0x04
ShockPayload    = 56 bytes   MsgType 0x01   (header is 4 bytes)
```

---

## Tech Stack

| Layer     | Technology                                | Purpose                            |
|-----------|-------------------------------------------|------------------------------------|
| Engine    | C++23, POSIX threads, AVX2 / FMA3         | Risk computation, Monte Carlo VaR  |
| Memory    | CSR SoA, `std::array`, stack allocation   | Cache-optimal graph storage        |
| Pipeline  | LMAX Disruptor (custom, lock-free)        | Inter-thread comms                 |
| Network   | uWS WebSocket (binary frames) + UDP mcast | Sub-millisecond data delivery      |
| Bridge    | Next.js Node routes (SSE + POST)          | Browser-friendly transport         |
| Frontend  | Next.js 15, MapLibre, deck.gl, Zustand    | Geo visualization + state mgmt     |
| Styling   | Tailwind CSS (dark mode only)             | UI framework                       |
| Chat      | LLM-routed natural-language → binary shock | Operator interface                 |

---

## Frontend non-negotiables

1. **No JSON parsing from the backend.** All hot-path messages are binary.
2. **No simulation logic in the frontend.** No contagion math, no pricing, no liquidation logic — the frontend only renders state.
3. **No heavy analytics dashboard in V1.** Graph + chat + lightweight node summary is enough.
4. **No DOM/SVG main graph renderer.** Stays GPU-backed via deck.gl.
5. **Desktop-first.** No mobile layout in V1.

See `frontend/CLAUDE.md` for the full design system (typography, color, motion, label rules).

---

## Getting Started

### Backend

```bash
cd backend
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
./optirisk
```

The engine listens on WS port `8080` and reads its initial market state from `optirisk_memory.bin` (generated by `scripts/infer_network.py`).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The page boots the SSE bridge automatically.

---

## Suggested code-tour order

1. `app/page.tsx` — the entire UI shell in ~50 lines.
2. `README.md` architecture diagram — how data flows.
3. `backend/src/main.cpp` — the three threads, one file.
4. `backend/src/memory/csr_graph.hpp` — the whole 500-node network in one stack-allocated struct.
5. `backend/src/network/wire_protocol.hpp` next to `frontend/lib/binary/schema.ts` — the binary contract.
6. Run it, click a shock, watch the cascade.

---

## Team

Built in 30 hours for HackPrinceton.

## License

MIT
