#pragma once
// ============================================================================
// csr_graph.hpp — Zero-Allocation CSR Graph (Struct of Arrays)
//
// Compressed Sparse Row representation of a 500-node counterparty network.
// Fully stack-allocated using std::array. No heap. No exceptions.
// Optimized for sequential cache-line traversal during BFS/PageRank.
//
// Data model mirrors generate_data.py:
//   - Pareto-distributed total assets
//   - Dirichlet-allocated portfolio (5 asset classes)
//   - Preferential-attachment debt edges (2–12 per node)
//   - Gaussian-clustered geospatial hubs
// ============================================================================

#include <array>
#include <cstdint>
#include <cstring>
#include <utility>

namespace optirisk::memory {

// ── Compile-Time Graph Dimensions ──────────────────────────────────
//
// MAX_NODES: Fixed at 500 per the hackathon spec.
// MAX_EDGES: 500 nodes × up to 12 edges = 6000, rounded to nearest
//            power-of-two (8192) for bitmask-friendly indexing and
//            headroom. Every byte is contiguous in .bss — no heap.
//
inline constexpr std::size_t MAX_NODES = 500;
inline constexpr std::size_t MAX_EDGES = 8192;

// ── Hub Identifiers (interned at I/O boundary) ────────────────────
// Strings are STRICTLY PROHIBITED on the hot path.
// Hub names are hashed to uint8_t enum values during JSON load.
enum class HubId : uint8_t {
    NYC       = 0,
    London    = 1,
    Tokyo     = 2,
    HongKong  = 3,
    Dubai     = 4,
    Unknown   = 255
};

// ── Node Data (SoA layout for cache-friendly access) ───────────────
//
// Each array is a single contiguous allocation. When the compute
// thread iterates risk_score[0..N], it streams through one cache line
// at a time without thrashing — pure sequential prefetch from the
// hardware prefetcher. Cross-field access (e.g., risk + exposure for
// the same node) costs an extra cache miss, but that trade-off is
// correct: the hot loop touches one field across ALL nodes, not all
// fields for one node.
//
// Financial quantities use double (64-bit IEEE 754) to avoid
// accumulation error on sums across 500 Pareto-distributed values
// that span $100M to $10B+.
//
struct alignas(64) NodeData {
    // ── Risk State (hot — touched every tick) ─────────────────────
    std::array<float,    MAX_NODES> risk_score{};        // Current risk ∈ [0.0, 1.0]
    std::array<uint8_t,  MAX_NODES> is_defaulted{};      // 1 = defaulted, 0 = alive
    std::array<uint8_t,  MAX_NODES> is_hero_firm{};      // 1 = user-controlled entity

    // ── Portfolio Exposures (Dirichlet-allocated, warm path) ──────
    std::array<double,   MAX_NODES> equities_exposure{};  // SPY-anchored
    std::array<double,   MAX_NODES> real_estate_exposure{};// VNQ-anchored
    std::array<double,   MAX_NODES> crypto_exposure{};    // BTC-anchored
    std::array<double,   MAX_NODES> treasuries_exposure{}; // TLT-anchored
    std::array<double,   MAX_NODES> corp_bonds_exposure{}; // LQD-anchored

    // ── Balance Sheet (warm path) ────────────────────────────────
    std::array<double,   MAX_NODES> total_assets{};       // Pareto-distributed
    std::array<double,   MAX_NODES> liabilities{};        // Sum of outgoing debt edges
    std::array<double,   MAX_NODES> nav{};                // total_assets − liabilities

    // ── Credit & Classification (cold path — read during cascade) ─
    std::array<float,    MAX_NODES> credit_rating{};      // Synthetic credit score
    std::array<uint32_t, MAX_NODES> sector_id{};          // Sector classification

    // ── Geospatial (cold path — used for frontend viz only) ──────
    std::array<float,    MAX_NODES> latitude{};
    std::array<float,    MAX_NODES> longitude{};
    std::array<HubId,    MAX_NODES> hub_id{};
};

// ── CSR Edge Storage ───────────────────────────────────────────────
//
// Compressed Sparse Row is the gold standard for sparse graph traversal:
//   row_ptr[i] .. row_ptr[i+1] gives the index range into col_idx[]
//   that are neighbors (creditors) of node i.
//
// Example: neighbors of node 3 → col_idx[ row_ptr[3] .. row_ptr[4] )
//          edge weights         → weight[ row_ptr[3] .. row_ptr[4] )
//
// Memory layout:
//   row_ptr   → MAX_NODES+1 uint32_t  (2004 bytes)
//   col_idx   → MAX_EDGES   uint32_t  (32 KB)
//   weight    → MAX_EDGES   double    (64 KB)
//
// Total edge storage: ~98 KB — fits in L2. col_idx and weight are
// accessed together during cascade so they should remain warm.
//
struct alignas(64) CSREdges {
    std::array<uint32_t, MAX_NODES + 1> row_ptr{};   // Prefix-sum offsets
    std::array<uint32_t, MAX_EDGES>     col_idx{};    // Target node (creditor) indices
    std::array<double,   MAX_EDGES>     weight{};     // Debt amount on this edge (USD)
};

// ── CSR Graph (Complete Stack-Allocated Structure) ─────────────────
//
// sizeof(CSRGraph) ≈ 60 KB (nodes) + 98 KB (edges) = ~158 KB.
// Declared `static` in main to place in .bss (zero-initialized by the
// OS loader, no runtime memset cost). Fits comfortably in L2/L3.
//
struct CSRGraph {
    NodeData  nodes;
    CSREdges  edges;
    uint32_t  num_nodes = 0;
    uint32_t  num_edges = 0;

    // Reset all data to zero (used at startup or between simulation rounds)
    constexpr void clear() noexcept {
        nodes = NodeData{};
        edges = CSREdges{};
        num_nodes = 0;
        num_edges = 0;
    }

    // ── Graph Construction API ─────────────────────────────────────

    // Call once after setting row_ptr to finalize the node count.
    constexpr void set_node_count(uint32_t n) noexcept {
        num_nodes = (n <= MAX_NODES) ? n : MAX_NODES;
    }

    // Add an edge during the build phase (before finalize).
    // Caller must fill row_ptr separately via prefix-sum.
    constexpr bool add_edge(uint32_t idx, uint32_t target, double w) noexcept {
        if (idx >= MAX_EDGES) [[unlikely]] return false;
        edges.col_idx[idx] = target;
        edges.weight[idx]  = w;
        ++num_edges;
        return true;
    }

    // ── Traversal Helpers ──────────────────────────────────────────

    // Iterate neighbors of node `u`. Returns [begin, end) index range
    // into col_idx / weight arrays.
    [[nodiscard]] constexpr auto neighbors(uint32_t u) const noexcept
        -> std::pair<uint32_t, uint32_t>
    {
        return { edges.row_ptr[u], edges.row_ptr[u + 1] };
    }

    // Get the degree (number of outgoing edges) of node `u`.
    [[nodiscard]] constexpr uint32_t degree(uint32_t u) const noexcept {
        return edges.row_ptr[u + 1] - edges.row_ptr[u];
    }

    // Prefetch neighbor data into L1 cache before traversal.
    // Call this one iteration ahead in a BFS/cascade loop.
    void prefetch_neighbors(uint32_t u) const noexcept {
        const uint32_t begin = edges.row_ptr[u];
        // Prefetch the col_idx array segment (read intent, temporal locality L1)
        __builtin_prefetch(&edges.col_idx[begin], 0, 3);
        // Prefetch the corresponding weight array segment
        __builtin_prefetch(&edges.weight[begin], 0, 3);
    }
};

// ── Wire Format for Binary Serialization ───────────────────────────
// Flat POD struct with zero hidden padding. This is memcpy'd directly
// into a WebSocket frame. One of these is sent per node per tick.
//
// Wire layout (28 bytes):
//   [0..3]   node_id        uint32_t
//   [4..7]   risk_score     float
//   [8..15]  nav            double
//   [16..23] exposure_total double
//   [24]     is_defaulted   uint8_t
//   [25]     hub_id         uint8_t
//   [26..27] _pad           2 bytes → 28 bytes total (4-byte aligned)
//
#pragma pack(push, 1)
struct NodeSnapshot {
    uint32_t node_id;
    float    risk_score;
    double   nav;
    double   exposure_total;
    uint8_t  is_defaulted;
    uint8_t  hub_id;
    uint8_t  _pad[2];
};
#pragma pack(pop)

static_assert(sizeof(NodeSnapshot) == 28,
              "NodeSnapshot must be exactly 28 bytes for binary framing");

// ── Market Anchor Snapshot (sent once at connection handshake) ─────
// Captures the real-time market baseline prices for the 5 asset classes.
#pragma pack(push, 1)
struct MarketAnchors {
    double equities;      // SPY close
    double real_estate;   // VNQ close
    double crypto;        // BTC-USD close
    double treasuries;    // TLT close
    double corp_bonds;    // LQD close
};
#pragma pack(pop)

static_assert(sizeof(MarketAnchors) == 40,
              "MarketAnchors must be exactly 40 bytes");

} // namespace optirisk::memory
