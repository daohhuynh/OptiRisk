# CLAUDE.md — OptiRisk AI Agent Instructions

## Project Identity
OptiRisk is a high-frequency counterparty risk simulator built for a 30-hour hackathon. It consists of a bare-metal C++23 backend and a Next.js/WebGL frontend.

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

1.  **Framework**: Next.js (App Router) with TypeScript.
2.  **3D Rendering**: React Three Fiber (`@react-three/fiber`) and Drei (`@react-three/drei`). The primary visualization is a 3D risk topology rendered on a dark globe/grid.
3.  **State Management**: Zustand for global state (risk graph data, connection status).
4.  **Data Ingestion**: The frontend receives data over a WebSocket as raw `ArrayBuffer`. It MUST parse binary data directly (using `DataView` or typed arrays). Do NOT parse JSON from the backend.
5.  **Styling**: Tailwind CSS. Dark mode is the default and only theme.

---

## Architecture Diagram (Mental Model)

```
[Market Feed Sim] → [Disruptor Ring Buffer] → [CSR Graph Engine] → [Binary WebSocket] → [React Three Fiber Globe]
   (Thread 1)           (Lock-Free)             (Thread 2)            (Thread 3)            (Browser)
```

## File Conventions
- Backend headers: `.hpp` (no `.h`)
- Backend source: `.cpp`
- Frontend components: PascalCase `.tsx`
- Frontend hooks: camelCase `use*.ts`
