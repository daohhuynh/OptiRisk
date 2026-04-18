// ============================================================================
// main.cpp — OptiRisk Entry Point
//
// Bootstraps the 3-thread Disruptor pipeline:
//   Thread 1: Market event ingestion (simulated feed)
//   Thread 2: CSR graph risk computation
//   Thread 3: Binary WebSocket publisher
// ============================================================================

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <thread>
#include <chrono>
#include <random>
#include <atomic>
#include <csignal>

#include "memory/csr_graph.hpp"
#include "concurrency/disruptor.hpp"

// ── Global Shutdown Flag ───────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signal_handler(int) {
    g_running.store(false, std::memory_order_relaxed);
}

// ── Pipeline Event Types ───────────────────────────────────────────
struct MarketEvent {
    uint32_t node_id;
    float    delta_risk;     // Change in risk score
    float    delta_exposure;  // Change in exposure
    uint64_t timestamp_ns;
};

struct RiskUpdate {
    optirisk::memory::NodeSnapshot snapshot;
    uint64_t computation_ns;  // Latency tracking
};

// ── Type Aliases ───────────────────────────────────────────────────
using MarketRing = optirisk::concurrency::Disruptor<
    MarketEvent, optirisk::concurrency::PIPELINE_RING_SIZE>;
using RiskRing = optirisk::concurrency::Disruptor<
    RiskUpdate, optirisk::concurrency::PIPELINE_RING_SIZE>;

// ── Thread 1: Market Feed Simulator ────────────────────────────────
static void ingest_thread(MarketRing& ring, uint32_t num_nodes) {
    std::mt19937 rng(42);  // Fixed seed for reproducibility
    std::uniform_int_distribution<uint32_t> node_dist(0, num_nodes - 1);
    std::uniform_real_distribution<float>    risk_dist(-0.05f, 0.10f);
    std::uniform_real_distribution<float>    expo_dist(-2.0f, 5.0f);

    while (g_running.load(std::memory_order_relaxed)) {
        const auto now = std::chrono::steady_clock::now().time_since_epoch();
        const auto ns  = std::chrono::duration_cast<std::chrono::nanoseconds>(now).count();

        auto seq = ring.claim();
        auto& evt = ring.get(seq);
        evt.node_id        = node_dist(rng);
        evt.delta_risk     = risk_dist(rng);
        evt.delta_exposure = expo_dist(rng);
        evt.timestamp_ns   = static_cast<uint64_t>(ns);
        ring.publish(seq);

        // ~10,000 events/sec simulated throughput
        std::this_thread::sleep_for(std::chrono::microseconds(100));
    }
}

// ── Thread 2: Risk Computation Engine ──────────────────────────────
static void compute_thread(MarketRing& in_ring, RiskRing& out_ring,
                           optirisk::memory::CSRGraph& graph) {
    int64_t last_seen = -1;

    while (g_running.load(std::memory_order_relaxed)) {
        auto maybe_event = in_ring.try_read(last_seen);
        if (!maybe_event) {
            // Busy-wait with backoff
            #if defined(__x86_64__)
                asm volatile("pause" ::: "memory");
            #endif
            continue;
        }

        const auto& evt = *maybe_event;
        const uint32_t nid = evt.node_id;

        // Apply market event to graph
        auto& risk = graph.nodes.risk_score[nid];
        risk = std::clamp(risk + evt.delta_risk, 0.0f, 1.0f);
        graph.nodes.exposure[nid] += evt.delta_exposure;

        // Default detection: risk > 0.95 triggers default
        if (risk > 0.95f && graph.nodes.is_defaulted[nid] == 0) {
            graph.nodes.is_defaulted[nid] = 1;

            // Cascade: propagate shock to neighbors
            auto [begin, end] = graph.neighbors(nid);
            for (uint32_t i = begin; i < end; ++i) {
                uint32_t neighbor = graph.edges.col_idx[i];
                float weight = graph.edges.edge_weight[i];
                graph.nodes.risk_score[neighbor] =
                    std::clamp(graph.nodes.risk_score[neighbor] + weight * 0.3f, 0.0f, 1.0f);
            }
        }

        // Publish risk update
        const auto now_ns = std::chrono::steady_clock::now().time_since_epoch();
        auto seq = out_ring.claim();
        auto& update = out_ring.get(seq);
        update.snapshot.node_id       = nid;
        update.snapshot.risk_score    = risk;
        update.snapshot.exposure      = graph.nodes.exposure[nid];
        update.snapshot.is_defaulted  = graph.nodes.is_defaulted[nid];
        std::memset(update.snapshot._pad, 0, sizeof(update.snapshot._pad));
        update.computation_ns = static_cast<uint64_t>(
            std::chrono::duration_cast<std::chrono::nanoseconds>(now_ns).count()
        ) - evt.timestamp_ns;
        out_ring.publish(seq);
    }
}

// ── Thread 3: Binary Publisher (Stub — WebSocket TBD) ──────────────
static void publish_thread(RiskRing& ring) {
    int64_t last_seen = -1;
    uint64_t msg_count = 0;
    auto last_report = std::chrono::steady_clock::now();

    while (g_running.load(std::memory_order_relaxed)) {
        auto maybe_update = ring.try_read(last_seen);
        if (!maybe_update) {
            #if defined(__x86_64__)
                asm volatile("pause" ::: "memory");
            #endif
            continue;
        }

        const auto& update = *maybe_update;
        ++msg_count;

        // TODO: Send update.snapshot as raw binary over WebSocket
        // For now, periodic throughput report to stdout
        auto now = std::chrono::steady_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::seconds>(now - last_report);
        if (elapsed.count() >= 5) {
            std::printf("[publish] %llu msgs | last node=%u risk=%.3f latency=%llu ns\n",
                        static_cast<unsigned long long>(msg_count),
                        update.snapshot.node_id,
                        static_cast<double>(update.snapshot.risk_score),
                        static_cast<unsigned long long>(update.computation_ns));
            last_report = now;
        }
    }
}

// ── Build a synthetic test graph ───────────────────────────────────
static void build_test_graph(optirisk::memory::CSRGraph& graph, uint32_t num_nodes) {
    graph.clear();
    graph.set_node_count(num_nodes);

    // Build a random sparse graph with ~8 edges per node
    std::mt19937 rng(123);
    std::uniform_int_distribution<uint32_t> target_dist(0, num_nodes - 1);
    std::uniform_real_distribution<float>   weight_dist(0.01f, 0.5f);
    std::uniform_real_distribution<float>   credit_dist(0.1f, 0.9f);

    // First pass: count edges per node to build row_ptr
    constexpr uint32_t EDGES_PER_NODE = 8;
    uint32_t edge_idx = 0;

    graph.edges.row_ptr[0] = 0;
    for (uint32_t u = 0; u < num_nodes; ++u) {
        graph.nodes.risk_score[u]    = 0.1f;
        graph.nodes.exposure[u]      = weight_dist(rng) * 100.0f;
        graph.nodes.credit_rating[u] = credit_dist(rng);
        graph.nodes.sector_id[u]     = u % 10;

        for (uint32_t e = 0; e < EDGES_PER_NODE; ++e) {
            uint32_t target = target_dist(rng);
            if (target == u) target = (target + 1) % num_nodes; // No self-loops
            graph.add_edge(edge_idx, target, weight_dist(rng));
            ++edge_idx;
        }
        graph.edges.row_ptr[u + 1] = edge_idx;
    }
}

// ── Main ───────────────────────────────────────────────────────────
int main() {
    std::signal(SIGINT,  signal_handler);
    std::signal(SIGTERM, signal_handler);

    constexpr uint32_t NUM_NODES = 500;

    std::printf("═══════════════════════════════════════════\n");
    std::printf("  OptiRisk — Counterparty Risk Simulator\n");
    std::printf("  Nodes: %u | Ring Size: %zu\n",
                NUM_NODES, optirisk::concurrency::PIPELINE_RING_SIZE);
    std::printf("═══════════════════════════════════════════\n");

    // Build the counterparty graph (one-time heap-free init)
    static optirisk::memory::CSRGraph graph;  // static to avoid stack overflow
    build_test_graph(graph, NUM_NODES);
    std::printf("[init] Graph built: %u nodes, %u edges\n", graph.num_nodes, graph.num_edges);

    // Create disruptor rings
    static MarketRing market_ring;
    static RiskRing   risk_ring;

    // Launch pipeline threads
    std::thread t1(ingest_thread,  std::ref(market_ring), NUM_NODES);
    std::thread t2(compute_thread, std::ref(market_ring), std::ref(risk_ring), std::ref(graph));
    std::thread t3(publish_thread, std::ref(risk_ring));

    std::printf("[main] Pipeline running. Press Ctrl+C to stop.\n\n");

    t1.join();
    t2.join();
    t3.join();

    std::printf("\n[main] Shutdown complete.\n");
    return 0;
}
