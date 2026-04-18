// ============================================================================
// test_simd_engine.cpp — SIMD Compute Kernel Benchmark + Validation
//
// Tests:
//   1. Correctness: exposure × (1+delta) for all 5 asset classes
//   2. NAV = sum(exposures) − liabilities
//   3. Cascade detection + propagation
//   4. Throughput benchmark (ticks/sec)
//
// Build (ARM64):
//   g++ -std=c++23 -O3 -Wall -Wextra -Werror -I src \
//       src/compute/test_simd_engine.cpp -o build/test_simd_engine
//
// Build (x86-64 with AVX2):
//   g++ -std=c++23 -O3 -mavx2 -mfma -Wall -Wextra -Werror -I src \
//       src/compute/test_simd_engine.cpp -o build/test_simd_engine
// ============================================================================

#include <cstdio>
#include <cstdint>
#include <cmath>
#include <chrono>
#include <random>

#include "compute/simd_engine.hpp"
#include "memory/csr_graph.hpp"
#include "network/wire_protocol.hpp"

using namespace optirisk::compute;
using namespace optirisk::memory;
using namespace optirisk::network;

static int g_pass = 0;
static int g_fail = 0;

#define CHECK(expr, msg)                                                 \
    do {                                                                  \
        if (expr) { ++g_pass; }                                           \
        else {                                                            \
            ++g_fail;                                                     \
            std::printf("  FAIL: %s (%s:%d)\n", msg, __FILE__, __LINE__); \
        }                                                                 \
    } while (0)

// ── Build a synthetic graph for testing ───────────────────────────
static void build_test_graph(CSRGraph& graph, uint32_t num_nodes) {
    graph.clear();
    graph.set_node_count(num_nodes);

    std::mt19937 rng(42);
    std::uniform_int_distribution<uint32_t> target_dist(0, num_nodes - 1);

    constexpr double ASSET_BASELINE = 100'000'000.0;  // $100M

    for (uint32_t u = 0; u < num_nodes; ++u) {
        double pareto = (1.0 + static_cast<double>(rng() % 1000) / 100.0) * ASSET_BASELINE;
        double fifth = pareto / 5.0;

        graph.nodes.equities_exposure[u]    = fifth * 1.6;
        graph.nodes.real_estate_exposure[u] = fifth * 0.8;
        graph.nodes.crypto_exposure[u]      = fifth * 0.2;
        graph.nodes.treasuries_exposure[u]  = fifth * 1.2;
        graph.nodes.corp_bonds_exposure[u]  = fifth * 1.2;
        graph.nodes.total_assets[u]         = pareto;
        graph.nodes.risk_score[u]           = 0.10f;
        graph.nodes.is_defaulted[u]         = 0;
        graph.nodes.hub_id[u]               = static_cast<HubId>(u % 5);
    }

    // Build edges: 8 per node
    constexpr uint32_t EDGES_PER_NODE = 8;
    uint32_t edge_idx = 0;
    graph.edges.row_ptr[0] = 0;

    for (uint32_t u = 0; u < num_nodes; ++u) {
        for (uint32_t e = 0; e < EDGES_PER_NODE; ++e) {
            uint32_t target = target_dist(rng);
            if (target == u) target = (target + 1) % num_nodes;
            double debt = graph.nodes.total_assets[u] * 0.08;
            graph.add_edge(edge_idx, target, debt);
            graph.nodes.liabilities[u] += debt;
            ++edge_idx;
        }
        graph.edges.row_ptr[u + 1] = edge_idx;
    }

    // Finalize NAV
    for (uint32_t u = 0; u < num_nodes; ++u) {
        graph.nodes.nav[u] = graph.nodes.total_assets[u] - graph.nodes.liabilities[u];
    }
}

// ── Test 1: Exposure Update Correctness ───────────────────────────
static void test_exposure_update() {
    std::printf("[test] SIMD exposure update correctness\n");

    static CSRGraph graph;
    build_test_graph(graph, MAX_NODES);

    // Save original values for node 0
    const double orig_eq = graph.nodes.equities_exposure[0];
    const double orig_re = graph.nodes.real_estate_exposure[0];
    const double orig_cr = graph.nodes.crypto_exposure[0];

    // Apply a Lehman-style shock
    ShockPayload shock{};
    shock.target_node_id    = 0xFFFFFFFF;  // Market-wide
    shock.equities_delta    = -0.40;        // -40% equities
    shock.real_estate_delta = -0.25;        // -25% real estate
    shock.crypto_delta      = -0.10;        // -10% crypto
    shock.treasuries_delta  = 0.0;          // No change
    shock.corp_bonds_delta  = -0.15;        // -15% corp bonds

    apply_shock_simd(graph, shock);

    // Verify node 0
    double expected_eq = orig_eq * (1.0 + (-0.40));
    double expected_re = orig_re * (1.0 + (-0.25));
    double expected_cr = orig_cr * (1.0 + (-0.10));

    CHECK(std::fabs(graph.nodes.equities_exposure[0] - expected_eq) < 1.0,
          "equities_exposure[0] = original * 0.60");
    CHECK(std::fabs(graph.nodes.real_estate_exposure[0] - expected_re) < 1.0,
          "real_estate_exposure[0] = original * 0.75");
    CHECK(std::fabs(graph.nodes.crypto_exposure[0] - expected_cr) < 1.0,
          "crypto_exposure[0] = original * 0.90");

    std::printf("  node[0] eq: %.2f → %.2f (expected %.2f)\n",
                orig_eq, graph.nodes.equities_exposure[0], expected_eq);
    std::printf("  node[0] re: %.2f → %.2f (expected %.2f)\n",
                orig_re, graph.nodes.real_estate_exposure[0], expected_re);

    // Verify across all nodes (spot-check node 250)
    // After the shock, all nodes should have reduced exposures
    CHECK(graph.nodes.equities_exposure[250] > 0.0,
          "equities_exposure[250] still positive after -40%");
    CHECK(graph.nodes.equities_exposure[250] < graph.nodes.total_assets[250],
          "equities_exposure[250] < total_assets");
}

// ── Test 2: NAV Recomputation ─────────────────────────────────────
static void test_nav_recompute() {
    std::printf("[test] SIMD NAV recomputation\n");

    static CSRGraph graph;
    build_test_graph(graph, MAX_NODES);

    ShockPayload shock{};
    shock.equities_delta    = -0.30;
    shock.real_estate_delta = -0.20;
    shock.crypto_delta      = 0.0;
    shock.treasuries_delta  = 0.05;
    shock.corp_bonds_delta  = -0.10;

    apply_shock_simd(graph, shock);

    // Verify NAV = sum(exposures) − liabilities for node 100
    const uint32_t nid = 100;
    double expected_total = graph.nodes.equities_exposure[nid]
                          + graph.nodes.real_estate_exposure[nid]
                          + graph.nodes.crypto_exposure[nid]
                          + graph.nodes.treasuries_exposure[nid]
                          + graph.nodes.corp_bonds_exposure[nid];
    double expected_nav = expected_total - graph.nodes.liabilities[nid];

    CHECK(std::fabs(graph.nodes.total_assets[nid] - expected_total) < 1.0,
          "total_assets[100] = sum of 5 exposures");
    CHECK(std::fabs(graph.nodes.nav[nid] - expected_nav) < 1.0,
          "nav[100] = total_assets - liabilities");

    std::printf("  node[100] total_assets: %.2f (expected %.2f)\n",
                graph.nodes.total_assets[nid], expected_total);
    std::printf("  node[100] nav: %.2f (expected %.2f)\n",
                graph.nodes.nav[nid], expected_nav);
}

// ── Test 3: Cascade Detection ─────────────────────────────────────
static void test_cascade() {
    std::printf("[test] cascade detection + propagation\n");

    static CSRGraph graph;
    build_test_graph(graph, MAX_NODES);

    // Force node 0 to near-default risk level
    graph.nodes.risk_score[0] = 0.94f;

    // Apply a massive shock to push it over the edge
    ShockPayload shock{};
    shock.equities_delta    = -0.60;  // -60%
    shock.real_estate_delta = -0.50;  // -50%
    shock.crypto_delta      = -0.80;  // -80%
    shock.treasuries_delta  = -0.30;  // -30%
    shock.corp_bonds_delta  = -0.40;  // -40%

    auto result = apply_shock_simd(graph, shock);

    CHECK(result.cascade.defaults_triggered > 0,
          "at least 1 default triggered by catastrophic shock");
    CHECK(graph.nodes.is_defaulted[0] == 1,
          "node 0 defaulted (was at 0.94 risk)");

    std::printf("  defaults triggered: %u\n", result.cascade.defaults_triggered);
    std::printf("  edges propagated:   %u\n", result.cascade.edges_propagated);
    std::printf("  node[0] is_defaulted: %u, risk: %.4f\n",
                graph.nodes.is_defaulted[0],
                static_cast<double>(graph.nodes.risk_score[0]));
}

// ── Test 4: Throughput Benchmark ──────────────────────────────────
static void benchmark_throughput() {
    std::printf("[bench] SIMD tick throughput\n");

    static CSRGraph graph;
    build_test_graph(graph, MAX_NODES);

    ShockPayload shock{};
    shock.equities_delta    = -0.01;   // -1% per tick
    shock.real_estate_delta = -0.005;
    shock.crypto_delta      = -0.02;
    shock.treasuries_delta  = 0.002;
    shock.corp_bonds_delta  = -0.003;

    constexpr uint32_t WARMUP    = 1000;
    constexpr uint32_t BENCH_ITS = 100000;

    // Warmup (fill caches, stabilize branch predictors)
    for (uint32_t i = 0; i < WARMUP; ++i) {
        apply_shock_simd(graph, shock);
    }

    // Reset graph for clean benchmark
    build_test_graph(graph, MAX_NODES);

    auto start = std::chrono::high_resolution_clock::now();

    for (uint32_t i = 0; i < BENCH_ITS; ++i) {
        apply_shock_simd(graph, shock);
    }

    auto end = std::chrono::high_resolution_clock::now();
    auto elapsed_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(end - start).count();

    double ticks_per_sec = static_cast<double>(BENCH_ITS) /
                           (static_cast<double>(elapsed_ns) / 1'000'000'000.0);
    double ns_per_tick   = static_cast<double>(elapsed_ns) / static_cast<double>(BENCH_ITS);
    double nodes_per_sec = ticks_per_sec * MAX_NODES;

    std::printf("  %u iterations in %.3f ms\n",
                BENCH_ITS, static_cast<double>(elapsed_ns) / 1'000'000.0);
    std::printf("  %.0f ticks/sec  |  %.1f ns/tick  |  %.0f nodes/sec\n",
                ticks_per_sec, ns_per_tick, nodes_per_sec);

#if defined(OPTIRISK_AVX2)
    std::printf("  ISA: AVX2 + FMA3 (256-bit, 4 doubles/vector)\n");
#elif defined(OPTIRISK_NEON)
    std::printf("  ISA: ARM NEON (128-bit × 2, 4 doubles/iteration)\n");
#else
    std::printf("  ISA: Scalar fallback\n");
#endif
}

int main() {
    std::printf("═══════════════════════════════════════════════════════════\n");
    std::printf("  OptiRisk — SIMD Compute Kernel Tests\n");
    std::printf("  Nodes: %zu | Edges: %zu | Vector Width: %u doubles\n",
                MAX_NODES, MAX_EDGES, SIMD_WIDTH);
    std::printf("═══════════════════════════════════════════════════════════\n\n");

    test_exposure_update();
    test_nav_recompute();
    test_cascade();
    benchmark_throughput();

    std::printf("\n═══════════════════════════════════════════════════════════\n");
    std::printf("  Results: %d passed, %d failed\n", g_pass, g_fail);
    std::printf("═══════════════════════════════════════════════════════════\n");

    return g_fail > 0 ? 1 : 0;
}
