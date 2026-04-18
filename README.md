# OptiRisk

**Real-time counterparty risk simulation at HFT speeds.**

OptiRisk is a high-performance counterparty credit risk engine that models cascading default propagation across a 500-node financial network — and visualizes it in real time on a 3D WebGL globe.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        OptiRisk Pipeline                            │
│                                                                     │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐   │
│  │  Market Feed  │───▶│  Risk Engine  │───▶│  Binary Publisher    │   │
│  │  Simulator    │    │  (CSR Graph)  │    │  (WebSocket Server)  │   │
│  │  Thread 1     │    │  Thread 2     │    │  Thread 3            │   │
│  └──────────────┘    └──────────────┘    └──────────┬───────────┘   │
│         │                    │                       │               │
│         └────────────────────┘                       │               │
│              Lock-Free Disruptor                     │               │
│              Ring Buffer (64B aligned)                │               │
└──────────────────────────────────────────────────────┼───────────────┘
                                                       │
                                              Binary WebSocket
                                                       │
                                          ┌────────────▼────────────┐
                                          │   Next.js Frontend      │
                                          │   React Three Fiber     │
                                          │   3D Risk Topology      │
                                          └─────────────────────────┘
```

## Why This Design?

### Zero-Allocation C++23 Backend
Traditional risk engines rely on heap-heavy data structures that trigger GC pauses or allocator contention under load. OptiRisk eliminates this entirely:
- **CSR (Compressed Sparse Row) Graph**: The 500-node counterparty network is stored as a Struct of Arrays using `std::array` — fully stack-allocated, maximizing L1/L2 cache hit rates during BFS and PageRank traversals.
- **LMAX Disruptor Ring Buffer**: Inter-thread communication uses a lock-free ring buffer with `alignas(64)` cache-line padding and atomic sequence cursors. Zero contention, zero syscalls.
- **Binary Wire Protocol**: Data is serialized as flat structs via `memcpy` directly into WebSocket frames. No JSON overhead, no serialization libraries.

### Real-Time 3D Visualization
The frontend renders a live 3D topology of the counterparty network using React Three Fiber:
- Nodes represent financial institutions, colored by risk score.
- Edges represent exposure links, with thickness proportional to notional value.
- Default cascades animate as shockwaves propagating through the graph.

## Tech Stack

| Layer     | Technology                                | Purpose                        |
|-----------|-------------------------------------------|--------------------------------|
| Engine    | C++23, POSIX Threads                      | Risk computation               |
| Memory    | CSR SoA, `std::array`, stack allocation   | Cache-optimal graph storage    |
| Pipeline  | LMAX Disruptor (custom)                   | Lock-free inter-thread comms   |
| Network   | Raw WebSocket (binary frames)             | Sub-millisecond data delivery  |
| Frontend  | Next.js, React Three Fiber, Zustand       | 3D visualization + state mgmt |
| Styling   | Tailwind CSS (dark mode)                  | UI framework                   |

## Getting Started

### Backend
```bash
cd backend
mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make -j$(nproc)
./optirisk
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the risk topology.

## Team
Built in 30 hours for [Hackathon Name].

## License
MIT
