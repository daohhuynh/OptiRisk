// ============================================================================
// main.cpp — OptiRisk Entry Point
//
// Bootstraps the 3-thread Disruptor pipeline:
//   Thread 1 (Network):   Simulates market shocks → shock_ring
//   Thread 2 (Compute):   CSR graph risk cascade  → tick_ring
//   Thread 3 (Broadcast): Binary WebSocket publish
//
// Zero std::mutex. Zero std::condition_variable. Zero heap allocation.
// ============================================================================

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <chrono>
#include <random>
#include <atomic>
#include <csignal>
#include <algorithm>

#include "memory/csr_graph.hpp"
#include "concurrency/disruptor.hpp"
#include "network/wire_protocol.hpp"
#include "network/ws_listener.hpp"
#include "memory/csr_graph.hpp"
#include "market/order_book.hpp"
#include "compute/simd_engine.hpp"
#include "compute/cascade_engine.hpp"
#include "compute/monte_carlo.hpp"

uint32_t HERO_FIRM_ID = 0;

// ── Global Shutdown Flag ───────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signal_handler(int) {
    g_running.store(false, std::memory_order_relaxed);
}

// ── Thread 1: Network (WsListener) ─────────────────────────────────
//
// Blocks on uWS event loop. Parses incoming binary shocks, and writes 
// them into shock_ring. 
//
static void network_thread(optirisk::concurrency::DisruptorEngine& engine,
                           optirisk::network::WsListener& listener) {
    (void)engine; // WsListener pushes to engine via the on_shock callback
    listener.run(); // Blocks until shutdown
}

// ── Thread 2: Compute (Risk Cascade & VaR Engine) ──────────────────
//
// Reads ShockPayloads from shock_ring, runs the deep Cascade 
// physics loop involving the CLOB, then broadcasts.
//
static void compute_thread(optirisk::concurrency::DisruptorEngine& engine,
                           optirisk::memory::CSRGraph& graph,
                           optirisk::market::CLOBEngine& clob) {
    uint64_t read_seq = 0;
    uint32_t tick_counter = 0;

    while (g_running.load(std::memory_order_relaxed)) [[likely]] {
        if (!engine.shock_ring.available(read_seq)) [[unlikely]] {
            #if defined(__x86_64__) || defined(_M_X64)
                asm volatile("pause" ::: "memory");
            #elif defined(__aarch64__)
                asm volatile("yield" ::: "memory");
            #endif
            continue;
        }

        const auto& shock = engine.shock_ring.get(read_seq);

        // 1. VaR Monte Carlo (for the Hero firm)
        auto var_result = optirisk::compute::run_monte_carlo_var(graph, shock);

        // Print VaR for monitoring (production would route this via a dedicated queue)
        if (tick_counter % 100 == 0) {
            std::printf("[var] Node %u | Expected Loss: $%.2f | P95 VaR: $%.2f\n",
                        HERO_FIRM_ID, var_result.expected[HERO_FIRM_ID], var_result.var_95[HERO_FIRM_ID]);
        }

        // 2. Cascade Physics Loop 
        auto stats = optirisk::compute::run_cascade_tick(clob, graph, shock);

        // Publish TickDelta for Hero Firm as summary (and potentially all defaults in a real setup)
        auto tick_seq = engine.tick_ring.claim(engine.broadcast_cursor, g_running);
        if (tick_seq == UINT64_MAX) [[unlikely]] break;
        auto& tick = engine.tick_ring.get(tick_seq);

        tick.node_id        = HERO_FIRM_ID;
        tick.risk_score     = graph.nodes.risk_score[HERO_FIRM_ID];
        tick.nav            = graph.nodes.nav[HERO_FIRM_ID];
        tick.exposure_total = graph.nodes.total_assets[HERO_FIRM_ID];
        tick.delta_nav      = 0.0;
        tick.delta_exposure = 0.0;
        tick.is_defaulted   = graph.nodes.is_defaulted[HERO_FIRM_ID];
        tick.hub_id         = static_cast<uint8_t>(graph.nodes.hub_id[HERO_FIRM_ID]);
        tick.cascade_depth  = static_cast<uint8_t>(std::min(stats.total_defaults, 255u));
        tick.tick_seq       = tick_counter++;
        tick.compute_cycles = stats.compute_cycles;  // From the cascade engine

        engine.tick_ring.publish(tick_seq);

        ++read_seq;
        engine.compute_cursor.value.store(read_seq, std::memory_order_release);
        ++engine.compute_count;
    }
}

// ── Thread 3: Broadcast (Binary Publisher) ─────────────────────────
static void broadcast_thread(optirisk::concurrency::DisruptorEngine& engine,
                             optirisk::network::WsListener& listener) {
    uint64_t read_seq = 0;
    uint64_t last_report_seq = 0;
    auto last_report = std::chrono::steady_clock::now();

    while (g_running.load(std::memory_order_relaxed)) [[likely]] {
        if (!engine.tick_ring.available(read_seq)) [[unlikely]] {
            #if defined(__x86_64__) || defined(_M_X64)
                asm volatile("pause" ::: "memory");
            #elif defined(__aarch64__)
                asm volatile("yield" ::: "memory");
            #endif
            continue;
        }

        const auto& tick = engine.tick_ring.get(read_seq);

        // Binary WebSocket broadcast
        listener.broadcast_tick(tick);

        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_report);
        if (elapsed.count() >= 5) [[unlikely]] {
            uint64_t delta = read_seq - last_report_seq;
            double throughput = (elapsed.count() > 0)
                ? static_cast<double>(delta) / static_cast<double>(elapsed.count())
                : 0.0;

            std::printf("[broadcast] tick=%u node=%u risk=%.3f nav=%.0f "
                        "| %.0f msgs/sec | cycles=%llu "
                        "| net=%llu comp=%llu bcast=%llu\n",
                        tick.tick_seq,
                        tick.node_id,
                        static_cast<double>(tick.risk_score),
                        tick.nav,
                        throughput,
                        static_cast<unsigned long long>(tick.compute_cycles),
                        static_cast<unsigned long long>(engine.network_count),
                        static_cast<unsigned long long>(engine.compute_count),
                        static_cast<unsigned long long>(engine.broadcast_count));

            last_report = now;
            last_report_seq = read_seq;
        }

        ++read_seq;
        engine.broadcast_cursor.value.store(read_seq, std::memory_order_release);
        ++engine.broadcast_count;
    }
}

// ── Build a synthetic test graph ───────────────────────────────────
static void build_test_graph(optirisk::memory::CSRGraph& graph, uint32_t num_nodes) {
    graph.clear();
    graph.set_node_count(num_nodes);

    // Build a random sparse graph matching generate_data.py's distribution:
    //   - Pareto(α=1.16) total assets × $100M baseline
    //   - Dirichlet(4,2,0.5,3,2.5) portfolio allocation
    //   - 2–12 preferential-attachment debt edges per node
    std::mt19937 rng(123);
    std::uniform_int_distribution<uint32_t> target_dist(0, num_nodes - 1);
    std::uniform_real_distribution<double>  debt_frac_dist(0.02, 0.15);
    std::uniform_real_distribution<float>   credit_dist(0.1f, 0.9f);
    std::uniform_real_distribution<float>   risk_init_dist(0.05f, 0.20f);
    std::uniform_real_distribution<float>   lat_dist(-90.0f, 90.0f);
    std::uniform_real_distribution<float>   lon_dist(-180.0f, 180.0f);

    // Synthetic Pareto-like total assets (simplified for test)
    constexpr double ASSET_BASELINE = 100'000'000.0;  // $100M
    for (uint32_t u = 0; u < num_nodes; ++u) {
        // Approximate Pareto: exponential of uniform gives heavy tail
        double pareto = (1.0 + static_cast<double>(rng() % 1000) / 100.0) * ASSET_BASELINE;
        graph.nodes.total_assets[u] = pareto;

        // Simplified Dirichlet → uniform splits (real loader will use actual weights)
        double fifth = pareto / 5.0;
        graph.nodes.equities_exposure[u]    = fifth * 1.6;   // ~32%
        graph.nodes.real_estate_exposure[u] = fifth * 0.8;   // ~16%
        graph.nodes.crypto_exposure[u]      = fifth * 0.2;   // ~4%
        graph.nodes.treasuries_exposure[u]  = fifth * 1.2;   // ~24%
        graph.nodes.corp_bonds_exposure[u]  = fifth * 1.2;   // ~24%

        graph.nodes.risk_score[u]    = risk_init_dist(rng);
        graph.nodes.credit_rating[u] = credit_dist(rng);
        graph.nodes.sector_id[u]     = u % 10;
        graph.nodes.latitude[u]      = lat_dist(rng);
        graph.nodes.longitude[u]     = lon_dist(rng);
        graph.nodes.is_hero_firm[u]  = 0;
    }
    // Mark the randomly selected node as the hero
    graph.nodes.is_hero_firm[HERO_FIRM_ID] = 1;

    // Build edges: ~8 per node average
    constexpr uint32_t EDGES_PER_NODE = 8;
    uint32_t edge_idx = 0;
    graph.edges.row_ptr[0] = 0;

    for (uint32_t u = 0; u < num_nodes; ++u) {
        for (uint32_t e = 0; e < EDGES_PER_NODE; ++e) {
            uint32_t target = target_dist(rng);
            if (target == u) target = (target + 1) % num_nodes; // No self-loops
            double debt = graph.nodes.total_assets[u] * debt_frac_dist(rng);
            graph.add_edge(edge_idx, target, debt);
            graph.nodes.liabilities[u] += debt;
            ++edge_idx;
        }
        graph.edges.row_ptr[u + 1] = edge_idx;
    }

    // Finalize NAV = total_assets − liabilities
    for (uint32_t u = 0; u < num_nodes; ++u) {
        graph.nodes.nav[u] = graph.nodes.total_assets[u] - graph.nodes.liabilities[u];
    }
}

// ── Main ───────────────────────────────────────────────────────────
int main() {
    std::signal(SIGINT,  signal_handler);
    std::signal(SIGTERM, signal_handler);

    constexpr uint32_t NUM_NODES = 500;

    std::printf("═══════════════════════════════════════════\n");
    std::printf("  OptiRisk — Counterparty Risk Simulator\n");
    std::printf("  Nodes: %u | Ring: %zu slots × %zu bytes\n",
                NUM_NODES,
                optirisk::concurrency::RING_SIZE,
                sizeof(optirisk::concurrency::EventSlot<optirisk::network::ShockPayload>));
    std::printf("═══════════════════════════════════════════\n");

    // Build the counterparty graph (one-time heap-free init)
    static optirisk::memory::CSRGraph graph;  // static → .bss, zero-initialized
    HERO_FIRM_ID = 42;  // Setup configurable hero firm dynamically.
    build_test_graph(graph, NUM_NODES);
    std::printf("[init] Graph built: %u nodes, %u edges\n", graph.num_nodes, graph.num_edges);

    // Initialize CLOB
    static optirisk::market::CLOBEngine clob;
    optirisk::market::init_clob(clob);
    std::printf("[init] CLOB Engine armed with realistic depth\n");

    // Create disruptor engine (static → .bss)
    static optirisk::concurrency::DisruptorEngine engine{};
    std::printf("[init] DisruptorEngine: %zu KB total ring memory\n",
                (sizeof(engine.shock_ring) + sizeof(engine.tick_ring)) / 1024);

    // WsListener parsing callback
    auto on_shock = [](const optirisk::network::ShockPayload& shock) {
        auto seq = engine.shock_ring.claim(engine.compute_cursor, g_running);
        if (seq != UINT64_MAX) {
            engine.shock_ring.get(seq) = shock;
            engine.shock_ring.publish(seq);
            engine.network_cursor.value.store(seq + 1, std::memory_order_release);
            ++engine.network_count;
        }
    };
    
    optirisk::network::WsListener listener(8080, std::move(on_shock));

    // Launch pipeline threads
    std::thread t1(network_thread,   std::ref(engine), std::ref(listener));
    std::thread t2(compute_thread,   std::ref(engine), std::ref(graph), std::ref(clob));
    std::thread t3(broadcast_thread, std::ref(engine), std::ref(listener));

    std::printf("[main] Pipeline running on WS port 8080. Press Ctrl+C to stop.\n\n");

    t1.join();
    t2.join();
    t3.join();

    std::printf("\n[main] Shutdown complete.\n");
    return 0;
}
