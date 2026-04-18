#pragma once
// ============================================================================
// csr_graph.hpp — Zero-Allocation CSR Graph (Struct of Arrays)
//
// Compressed Sparse Row representation of a 500-node counterparty network.
// Fully stack-allocated using std::array. No heap. No exceptions.
// Optimized for sequential cache-line traversal during BFS/PageRank.
// ============================================================================

#include <array>
#include <cstdint>
#include <cstring>
#include <atomic>

namespace optirisk::memory {

// ── Compile-Time Graph Dimensions ──────────────────────────────────
inline constexpr std::size_t MAX_NODES = 500;
inline constexpr std::size_t MAX_EDGES = 8000;  // ~16 avg degree

// ── Node Data (SoA layout for cache-friendly access) ───────────────
struct alignas(64) NodeData {
    std::array<float,    MAX_NODES> risk_score{};       // Current risk [0.0, 1.0]
    std::array<float,    MAX_NODES> exposure{};          // Notional exposure (USD millions)
    std::array<float,    MAX_NODES> credit_rating{};     // Synthetic credit score
    std::array<uint8_t,  MAX_NODES> is_defaulted{};      // 1 = defaulted, 0 = alive
    std::array<uint32_t, MAX_NODES> sector_id{};         // Sector classification
};

// ── CSR Edge Storage ───────────────────────────────────────────────
//
// row_ptr[i] .. row_ptr[i+1] gives the range of column indices
// in col_idx[] that are neighbors of node i.
//
// Example: neighbors of node 3 → col_idx[row_ptr[3] .. row_ptr[4])
//          edge weights         → edge_weight[row_ptr[3] .. row_ptr[4])
//
struct alignas(64) CSREdges {
    std::array<uint32_t, MAX_NODES + 1> row_ptr{};      // Prefix-sum offsets
    std::array<uint32_t, MAX_EDGES>     col_idx{};       // Target node indices
    std::array<float,    MAX_EDGES>     edge_weight{};   // Edge exposure weight
};

// ── CSR Graph (Complete Stack-Allocated Structure) ─────────────────
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
    constexpr bool add_edge(uint32_t idx, uint32_t target, float weight) noexcept {
        if (idx >= MAX_EDGES) return false;
        edges.col_idx[idx]     = target;
        edges.edge_weight[idx] = weight;
        ++num_edges;
        return true;
    }

    // ── Traversal Helpers ──────────────────────────────────────────

    // Iterate neighbors of node `u`. Returns [begin, end) index range
    // into col_idx / edge_weight arrays.
    [[nodiscard]] constexpr auto neighbors(uint32_t u) const noexcept
        -> std::pair<uint32_t, uint32_t>
    {
        return { edges.row_ptr[u], edges.row_ptr[u + 1] };
    }

    // Get the degree (number of outgoing edges) of node `u`.
    [[nodiscard]] constexpr uint32_t degree(uint32_t u) const noexcept {
        return edges.row_ptr[u + 1] - edges.row_ptr[u];
    }
};

// ── Wire Format for Binary Serialization ───────────────────────────
// Flat POD struct that can be memcpy'd directly into a WebSocket frame.
// One of these is sent per node per tick.
struct alignas(4) NodeSnapshot {
    uint32_t node_id;
    float    risk_score;
    float    exposure;
    uint8_t  is_defaulted;
    uint8_t  _pad[3];  // Align to 16 bytes
};

static_assert(sizeof(NodeSnapshot) == 16, "NodeSnapshot must be 16 bytes for binary framing");

} // namespace optirisk::memory
