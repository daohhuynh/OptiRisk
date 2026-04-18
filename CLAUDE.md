# CLAUDE.md — OptiRisk AI Agent Instructions

## Project Identity
OptiRisk is a high-frequency counterparty risk simulator built for a 30-hour hackathon. It consists of a bare-metal C++23 backend and a Next.js/WebGL frontend.
---
## System Overview

The system has two runtime modes:

1. **Pre-shock mode**
   - world state is mostly static
   - graph topology and map placement are stable

2. **Simulation mode**
   - a user-triggered shock starts a contagion cascade
   - the backend updates risk state at fast tick intervals
   - the frontend renders and explains the evolving cascade

The frontend does not own the simulation physics. The backend does.
---

## Backend Rules (STRICT — Zero Tolerance)

1.  **Language Standard**: C++23 ONLY. Do not use any deprecated patterns or fallback to C++17/20.
2.  **Zero Heap Allocation**: The hot path MUST be allocation-free. Use `std::array`, stack buffers, and pre-allocated arenas. NEVER use `std::vector`, `std::map`, `std::unordered_map`, `std::string`, `new`, or `malloc` in the simulation loop. The only exception is one-time startup initialization.
3.  **Concurrency Model**: The pipeline uses a 3-stage LMAX Disruptor pattern (Ingest → Compute → Publish). Communication between stages is via a lock-free ring buffer with `alignas(64)` cache-line padding and `std::atomic` sequence cursors. Do NOT use `std::mutex`, `std::condition_variable`, or any blocking primitive.
4.  **Graph Memory Layout**: Counterparty graphs use Compressed Sparse Row (CSR) format stored as a Struct of Arrays (SoA) with `std::array`. This is critical for cache locality during BFS/PageRank traversals.
5.  **Networking Protocol**: ALL data sent to the frontend is **binary**. Do NOT use JSON, Protobuf, or any text-based serialization on the hot path. The wire format is a flat struct serialized with `memcpy` into a raw TCP/WebSocket frame.
6.  **Build System**: CMake. Compiler flags MUST include `-O3 -march=native -mavx2 -mfma`. Warnings are errors (`-Werror`).

---

## Frontend Rules

1. **Framework**: Next.js (App Router) with TypeScript.
2. **Rendering Stack**: MapLibre + deck.gl.
3. **Visualization Model**: The primary UI is a dark, Obsidian-inspired, 3D-capable geo graph for contagion simulation.
4. **State Management**: Zustand for global state.
5. **Data Ingestion**: The frontend receives data over WebSocket as raw `ArrayBuffer`. It MUST parse binary data directly with `DataView` or typed arrays. Do NOT parse JSON from the backend.
6. **Styling**: Tailwind CSS. Dark mode is the default and only theme.
7. **UI Scope**: Desktop-first for V1.
8. **Product Scope**: V1 prioritizes the graph and chat interface first, not a heavy analytics dashboard.
9. **Node Types**: V1 supports banks, firms, and sectors.
10. **Clustering**: Do not add clustering by default in V1 unless density becomes a blocker.
11. **Simulation Model**: The graph may be mostly static before a shock, but the frontend must handle frequent simulation updates once contagion starts.
12. **Abstraction Boundary**: The frontend should stay flexible about exact edge semantics until the economic model is finalized.

---

## Architecture Diagram (Mental Model)
```text
[Market Feed Sim] → [Disruptor Ring Buffer] → [CSR Graph Engine] → [Binary WebSocket] → [Next.js + MapLibre + deck.gl]
   (Thread 1)           (Lock-Free)             (Thread 2)            (Thread 3)         (Browser)
```
---
## File Conventions
- Backend headers: `.hpp` (no `.h`)
- Backend source: `.cpp`
- Frontend components: PascalCase `.tsx`
- Frontend hooks: camelCase `use*.ts`
- Frontend stores: `*Store.ts`
