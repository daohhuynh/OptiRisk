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
#include "network/udp_publisher.hpp"
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
                           optirisk::market::CLOBEngine& clob,
                           optirisk::network::UdpPublisher& udp) {
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
                        
            optirisk::network::VaRReport var_rep{};
            var_rep.target_node = HERO_FIRM_ID;
            var_rep.paths_run = var_result.paths_run;
            var_rep.var_95 = var_result.var_95[HERO_FIRM_ID];
            udp.broadcast_var(var_rep); // Blast UDP directly from compute loop
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
                             optirisk::network::WsListener& listener,
                             optirisk::network::UdpPublisher& udp) {
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

        // Binary WebSocket broadcast (TCP OUCH)
        listener.broadcast_tick(tick);
        
        // UDP Multicast broadcast (UDP ITCH)
        udp.broadcast_tick(tick);

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

// ── Load the QR Memory Binary ─────────────────────────────────────────
static void load_market_binary(optirisk::memory::CSRGraph& graph) {
    graph.clear();

    FILE* fp = std::fopen("../optirisk_memory.bin", "rb");
    if (!fp) {
        std::fprintf(stderr, "FATAL: Could not open ../optirisk_memory.bin. Run python scripts/infer_network.py first.\n");
        std::exit(1);
    }
    
    // We expect exactly 500 nodes based on our data pipeline
    constexpr size_t N = optirisk::memory::MAX_NODES;
    constexpr size_t E = optirisk::memory::MAX_EDGES;
    
    // Read NodeData arrays directly bypassing struct padding
    std::fread(graph.nodes.risk_score.data(), sizeof(float), N, fp);
    std::fread(graph.nodes.is_defaulted.data(), sizeof(uint8_t), N, fp);
    std::fread(graph.nodes.is_hero_firm.data(), sizeof(uint8_t), N, fp);
    std::fread(graph.nodes.equities_exposure.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.real_estate_exposure.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.crypto_exposure.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.treasuries_exposure.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.corp_bonds_exposure.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.total_assets.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.liabilities.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.nav.data(), sizeof(double), N, fp);
    std::fread(graph.nodes.credit_rating.data(), sizeof(float), N, fp);
    std::fread(graph.nodes.sector_id.data(), sizeof(uint32_t), N, fp);
    std::fread(graph.nodes.latitude.data(), sizeof(float), N, fp);
    std::fread(graph.nodes.longitude.data(), sizeof(float), N, fp);
    std::fread(graph.nodes.hub_id.data(), sizeof(uint8_t), N, fp);
    
    // Read CSREdges arrays
    std::fread(graph.edges.row_ptr.data(), sizeof(uint32_t), N + 1, fp);
    std::fread(graph.edges.col_idx.data(), sizeof(uint32_t), E, fp);
    std::fread(graph.edges.weight.data(), sizeof(double), E, fp);
    
    // Trailer
    std::fread(&graph.num_nodes, sizeof(uint32_t), 1, fp);
    std::fread(&graph.num_edges, sizeof(uint32_t), 1, fp);
    std::fread(&HERO_FIRM_ID, sizeof(uint32_t), 1, fp);
    
    std::fclose(fp);
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
    load_market_binary(graph);
    std::printf("[init] Graph loaded: %u nodes, %u edges\n", graph.num_nodes, graph.num_edges);
    std::printf("[init] Hero Firm ID dynamically mapped to: %u\n", HERO_FIRM_ID);

    // Initialize CLOB
    static optirisk::market::CLOBEngine clob;
    optirisk::market::init_clob(clob);
    std::printf("[init] CLOB Engine armed with realistic depth\n");

    // Create disruptor engine (static → .bss)
    static optirisk::concurrency::DisruptorEngine engine{};
    std::printf("[init] DisruptorEngine: %zu KB total ring memory\n",
                (sizeof(engine.shock_ring) + sizeof(engine.tick_ring)) / 1024);

    // Initialize UDP Multicast Publisher
    static optirisk::network::UdpPublisher udp{"239.255.0.1", 9090};

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
    std::thread t2(compute_thread,   std::ref(engine), std::ref(graph), std::ref(clob), std::ref(udp));
    std::thread t3(broadcast_thread, std::ref(engine), std::ref(listener), std::ref(udp));

    std::printf("[main] Pipeline running on WS port 8080. Press Ctrl+C to stop.\n\n");

    t1.join();
    t2.join();
    t3.join();

    std::printf("\n[main] Shutdown complete.\n");
    return 0;
}
