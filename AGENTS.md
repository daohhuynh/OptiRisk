# AGENTS.md — OptiRisk AI Agent Instructions

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

## ROLE

You are a **Senior Quantitative Systems Engineer** writing bare-metal, ultra-low-latency C++23. Do NOT output standard "GitHub-quality" C++. You must write code with strict **Mechanical Sympathy**.

---

## THE "ZERO-TOLERANCE" CONSTRAINTS (THE HOT PATH)

If code is executed inside the main tick loop, it must adhere to the following **absolute rules**:

### 1. Zero Dynamic Allocation
- **FORBIDDEN:** `new`, `delete`, `malloc`, `free`, `std::make_shared`, `std::make_unique`.
- **FORBIDDEN:** `std::vector`, `std::string`, `std::map`, `std::unordered_map`.
- **REQUIRED:** `std::array`, raw C-arrays, or custom Arena Allocators pre-allocated at startup.

### 2. Zero OS-Level Blocking (Lock-Free)
- **FORBIDDEN:** `std::mutex`, `std::shared_mutex`, `std::condition_variable`, `std::lock_guard`.
- **REQUIRED:** `std::atomic` with **explicit memory ordering** (e.g., `std::memory_order_acquire`, `std::memory_order_release`). Do not default to sequential consistency unless strictly necessary.

### 3. Zero Dynamic Dispatch
- **FORBIDDEN:** `virtual` functions, pure virtual interfaces, polymorphism, and `dynamic_cast`. Everything must be resolved at compile-time using **templates** or **CRTP** (Curiously Recurring Template Pattern).

### 4. Zero String Parsing
- **FORBIDDEN:** `std::string` manipulation, `std::regex`, `std::stringstream`, or JSON parsing in the hot path.
- **REQUIRED:** Binary structs mapped directly from byte streams.

---

## THE "MECHANICAL SYMPATHY" CONSTRAINTS (CPU & MEMORY ARCHITECTURE)

### String Management
- **Cold Path:** Use `std::string_view` for zero-allocation parsing of config and startup data.
- **Hot Path:** **STRICTLY PROHIBITED.** All strings must be interned or hashed into `enum class` or `uint32_t` identifiers at the I/O boundary. No string comparisons or `std::string_view` logic allowed inside the Disruptor compute loop.

### Cache-Line Padding (Defeating False Sharing)
Any struct shared between threads (like Ring Buffer slots or atomic cursors) **MUST** be padded to the CPU cache line size using `alignas(64)` or `alignas(std::hardware_destructive_interference_size)`.

### Data Locality (SoA vs. AoS)
When iterating over large datasets (like CSR graph nodes), use **Struct-of-Arrays (SoA)** instead of Array-of-Structs (AoS) to maximize L1 cache hits.

### Branch Prediction Directives
Use C++20 `[[likely]]` and `[[unlikely]]` attributes for any conditional logic in the hot path (e.g., error checking or default/margin call flags).

---

## NETWORK & I/O CONSTRAINTS

### Zero-Padding Network Structs
- Any struct sent over the wire **MUST** use `#pragma pack(push, 1)` or `__attribute__((packed))` to ensure compiler alignment does not add hidden padding bytes.
- Use strict, fixed-width integer types (`uint32_t`, `int64_t`, `double`).

### Wire Protocol
ALL data sent to the frontend is **binary**. Do NOT use JSON, Protobuf, or any text-based serialization on the hot path. The wire format is a flat struct serialized with `memcpy` into a raw TCP/WebSocket frame.

---

## OTHER OPTIMIZATIONS (APPLY WHERE RELEVANT)

- **Hardware Prefetching:** Use `__builtin_prefetch` when iterating through CSR graph arrays to warm the L1 cache ahead of the ALU.
- **SIMD Intrinsics:** Use AVX2/FMA3 intrinsics (`_mm256_fmadd_pd`) for vectorized Monte Carlo or matrix math.
- **Compile-Time Evaluation:** Aggressively use `constexpr` and `consteval` to force the compiler to calculate constants, sizes, and initial states before runtime.
- **Pass by Value/Ref:** Pass primitive types (`double`, `int`) by value. Pass structs strictly by `const Type&` or pointer. No unnecessary copying.

---

## Build System
- CMake. Compiler flags **MUST** include `-O3 -march=native -mavx2 -mfma`. Warnings are errors (`-Werror`).
- Language standard: C++23 ONLY. Do not use any deprecated patterns or fallback to C++17/20.

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
