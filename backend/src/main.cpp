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

// ── Global Shutdown Flag ───────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signal_handler(int) {
    g_running.store(false, std::memory_order_relaxed);
}

// ── Thread 1: Network (Shock Ingestion) ────────────────────────────
//
// Simulates receiving ShockPayloads from WebSocket clients.
// In production, this would be driven by ws_listener.hpp callbacks.
// Writes directly into shock_ring slots (zero-copy).
//
static void network_thread(optirisk::concurrency::DisruptorEngine& engine,
                           uint32_t num_nodes) {
    std::mt19937 rng(42);  // Fixed seed for reproducibility
    std::uniform_int_distribution<uint32_t> node_dist(0, num_nodes - 1);
    std::uniform_int_distribution<uint32_t> type_dist(0, 4);
    std::uniform_real_distribution<double>  delta_dist(-0.10, 0.05);

    while (g_running.load(std::memory_order_relaxed)) [[likely]] {
        const auto now = std::chrono::steady_clock::now().time_since_epoch();
        const auto ns  = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();

        // Claim a slot (back-pressure: spins if Compute hasn't caught up)
        auto seq = engine.shock_ring.claim(engine.compute_cursor, g_running);
        if (seq == UINT64_MAX) [[unlikely]] break;  // Shutdown during back-pressure
        auto& shock = engine.shock_ring.get(seq);

        shock.target_node_id    = node_dist(rng);
        shock.shock_type        = type_dist(rng);
        shock.equities_delta    = delta_dist(rng);
        shock.real_estate_delta = delta_dist(rng) * 0.5;
        shock.crypto_delta      = delta_dist(rng) * 2.0;
        shock.treasuries_delta  = delta_dist(rng) * 0.3;
        shock.corp_bonds_delta  = delta_dist(rng) * 0.4;
        shock.timestamp_ns      = static_cast<uint64_t>(ns);

        engine.shock_ring.publish(seq);

        engine.network_cursor.value.store(seq + 1, std::memory_order_release);
        ++engine.network_count;

        // ~10,000 events/sec simulated throughput
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
}

// ── Thread 2: Compute (Risk Cascade Engine) ────────────────────────
//
// Reads ShockPayloads from shock_ring, applies deltas to the CSR graph,
// runs cascade detection (BFS over CSR edges), and writes TickDeltas
// into tick_ring.
//
static void compute_thread(optirisk::concurrency::DisruptorEngine& engine,
                           optirisk::memory::CSRGraph& graph) {
    uint64_t read_seq = 0;
    uint32_t tick_counter = 0;

    while (g_running.load(std::memory_order_relaxed)) [[likely]] {
        // Spin until Network has published a new ShockPayload
        if (!engine.shock_ring.available(read_seq)) [[unlikely]] {
            #if defined(__x86_64__) || defined(_M_X64)
                asm volatile("pause" ::: "memory");
            #elif defined(__aarch64__)
                asm volatile("yield" ::: "memory");
            #endif
            continue;
        }

        const auto& shock = engine.shock_ring.get(read_seq);
        const uint32_t nid = shock.target_node_id;

        // ── Apply shock to portfolio ──────────────────────────────
        graph.nodes.equities_exposure[nid]    *= (1.0 + shock.equities_delta);
        graph.nodes.real_estate_exposure[nid] *= (1.0 + shock.real_estate_delta);
        graph.nodes.crypto_exposure[nid]      *= (1.0 + shock.crypto_delta);
        graph.nodes.treasuries_exposure[nid]  *= (1.0 + shock.treasuries_delta);
        graph.nodes.corp_bonds_exposure[nid]  *= (1.0 + shock.corp_bonds_delta);

        // Recalculate total assets and NAV
        const double old_nav = graph.nodes.nav[nid];
        const double new_total = graph.nodes.equities_exposure[nid]
                               + graph.nodes.real_estate_exposure[nid]
                               + graph.nodes.crypto_exposure[nid]
                               + graph.nodes.treasuries_exposure[nid]
                               + graph.nodes.corp_bonds_exposure[nid];
        graph.nodes.total_assets[nid] = new_total;
        graph.nodes.nav[nid] = new_total - graph.nodes.liabilities[nid];

        // ── Risk score update (simplified) ────────────────────────
        // NAV decline → risk increase (inverse relationship)
        float risk_delta = (old_nav > 0.0)
            ? static_cast<float>((old_nav - graph.nodes.nav[nid]) / old_nav) * 0.1f
            : 0.0f;
        auto& risk = graph.nodes.risk_score[nid];
        risk = std::clamp(risk + risk_delta, 0.0f, 1.0f);

        // ── Default detection & cascade ───────────────────────────
        uint8_t cascade_depth = 0;
        if (risk > 0.95f && graph.nodes.is_defaulted[nid] == 0) [[unlikely]] {
            graph.nodes.is_defaulted[nid] = 1;
            cascade_depth = 1;

            // Propagate shock to neighbors via CSR adjacency
            auto [begin, end] = graph.neighbors(nid);
            // Prefetch next node's edge data into L1
            if (begin < end) {
                graph.prefetch_neighbors(nid);
            }
            for (uint32_t i = begin; i < end; ++i) {
                uint32_t neighbor = graph.edges.col_idx[i];
                double debt = graph.edges.weight[i];
                float contagion = static_cast<float>(
                    debt / (graph.nodes.total_assets[neighbor] + 1.0)) * 0.3f;
                graph.nodes.risk_score[neighbor] =
                    std::clamp(graph.nodes.risk_score[neighbor] + contagion, 0.0f, 1.0f);
            }
        }

        // ── Build TickDelta and publish ───────────────────────────
        auto tick_seq = engine.tick_ring.claim(engine.broadcast_cursor, g_running);
        if (tick_seq == UINT64_MAX) [[unlikely]] break;  // Shutdown during back-pressure
        auto& tick = engine.tick_ring.get(tick_seq);

        tick.node_id        = nid;
        tick.risk_score     = risk;
        tick.nav            = graph.nodes.nav[nid];
        tick.exposure_total = new_total;
        tick.delta_nav      = graph.nodes.nav[nid] - old_nav;
        tick.delta_exposure = 0.0;  // TODO: track per-tick delta
        tick.is_defaulted   = graph.nodes.is_defaulted[nid];
        tick.hub_id         = static_cast<uint8_t>(graph.nodes.hub_id[nid]);
        tick.cascade_depth  = cascade_depth;
        tick.tick_seq       = tick_counter++;

        engine.tick_ring.publish(tick_seq);

        ++read_seq;
        engine.compute_cursor.value.store(read_seq, std::memory_order_release);
        ++engine.compute_count;
    }
}

// ── Thread 3: Broadcast (Binary Publisher) ─────────────────────────
//
// Reads TickDeltas from tick_ring and broadcasts them.
// In production, this calls WsListener::broadcast_tick().
// For now, periodic throughput reporting to stdout.
//
static void broadcast_thread(optirisk::concurrency::DisruptorEngine& engine) {
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

        // TODO: serialize TickDelta → binary frame → WebSocket broadcast
        // For now, periodic throughput report
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_report);
        if (elapsed.count() >= 5) [[unlikely]] {
            uint64_t delta = read_seq - last_report_seq;
            double throughput = (elapsed.count() > 0)
                ? static_cast<double>(delta) / static_cast<double>(elapsed.count())
                : 0.0;

            std::printf("[broadcast] tick=%u node=%u risk=%.3f nav=%.0f Δnav=%.0f "
                        "| %.0f msgs/sec | net=%llu comp=%llu bcast=%llu\n",
                        tick.tick_seq,
                        tick.node_id,
                        static_cast<double>(tick.risk_score),
                        tick.nav,
                        tick.delta_nav,
                        throughput,
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
        graph.nodes.hub_id[u]        = static_cast<optirisk::memory::HubId>(u % 5);
        graph.nodes.is_hero_firm[u]  = 0;
    }
    // Mark the largest firm as the hero
    graph.nodes.is_hero_firm[0] = 1;

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
    build_test_graph(graph, NUM_NODES);
    std::printf("[init] Graph built: %u nodes, %u edges\n", graph.num_nodes, graph.num_edges);

    // Create disruptor engine (static → .bss)
    static optirisk::concurrency::DisruptorEngine engine{};
    std::printf("[init] DisruptorEngine: %zu KB total ring memory\n",
                (sizeof(engine.shock_ring) + sizeof(engine.tick_ring)) / 1024);

    // Launch pipeline threads
    std::thread t1(network_thread,   std::ref(engine), NUM_NODES);
    std::thread t2(compute_thread,   std::ref(engine), std::ref(graph));
    std::thread t3(broadcast_thread, std::ref(engine));

    std::printf("[main] Pipeline running. Press Ctrl+C to stop.\n\n");

    t1.join();
    t2.join();
    t3.join();

    std::printf("\n[main] Shutdown complete.\n");
    return 0;
}
