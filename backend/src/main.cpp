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

#include "compute/cascade_engine.hpp"
#include "compute/monte_carlo.hpp"
#include "compute/simd_engine.hpp"
#include "concurrency/disruptor.hpp"
#include "market/order_book.hpp"
#include "memory/csr_graph.hpp"
#include "memory/options_book.hpp"
#include "network/udp_publisher.hpp"
#include "network/wire_protocol.hpp"
#include "network/ws_listener.hpp"
#include "utils/affinity.hpp"
#include <atomic>
#include <cmath>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <thread>

uint32_t HERO_FIRM_ID = 0;

// ── Global Shutdown Flag ───────────────────────────────────────────
static std::atomic<bool> g_running{true};

static void signal_handler([[maybe_unused]] int signum) {
  g_running.store(false, std::memory_order_relaxed);
}

static void load_market_binary(optirisk::memory::CSRGraph &graph);

static bool valid_delta(double x) noexcept {
  return std::isfinite(x) && x >= -1.00 && x <= 1.00;
}

static bool valid_shock(const optirisk::network::ShockPayload &shock) noexcept {
  return valid_delta(shock.equities_delta) &&
         valid_delta(shock.real_estate_delta) &&
         valid_delta(shock.crypto_delta) &&
         valid_delta(shock.treasuries_delta) &&
         valid_delta(shock.corp_bonds_delta);
}

// ── Thread 1: Network (WsListener) ─────────────────────────────────
//
// Blocks on uWS event loop. Parses incoming binary shocks, and writes
// them into shock_ring.
//
static void network_thread(optirisk::concurrency::DisruptorEngine &engine,
                           optirisk::network::WsListener &listener) {
  optirisk::utils::pin_thread_to_core(1); // Isolate Network to Core 1
  (void)engine;   // WsListener pushes to engine via the on_shock callback
  listener.run(); // Blocks until shutdown
}

// ── Thread 2: Compute (Risk Cascade & VaR Engine) ──────────────────
//
// Reads ShockPayloads from shock_ring, runs the deep Cascade
// physics loop involving the CLOB, then broadcasts.
//
static void compute_thread(optirisk::concurrency::DisruptorEngine &engine,
                           optirisk::memory::CSRGraph &graph,
                           optirisk::memory::OptionsBook &options,
                           optirisk::market::CLOBEngine &clob,
                           optirisk::network::UdpPublisher &udp) {
  optirisk::utils::pin_thread_to_core(2); // Isolate Math/Physics to Core 2

  uint64_t read_seq = 0;
  uint32_t tick_counter = 0;

  // Track state to only broadcast dirty nodes (fits perfectly in L1/L2 cache)
  std::array<double, optirisk::memory::MAX_NODES> prev_nav{};
  std::array<float, optirisk::memory::MAX_NODES> prev_risk{};
  for (uint32_t i = 0; i < graph.num_nodes; ++i) {
    prev_risk[i] = graph.nodes.risk_score[i];
  }
  std::array<uint8_t, optirisk::memory::MAX_NODES> prev_defaulted{};
  for (uint32_t i = 0; i < graph.num_nodes; ++i) {
    prev_nav[i] = graph.nodes.nav[i];
    prev_defaulted[i] = graph.nodes.is_defaulted[i];
  }

  while (g_running.load(std::memory_order_relaxed)) [[likely]] {
    if (!engine.shock_ring.available(read_seq)) [[unlikely]] {
#if defined(__x86_64__) || defined(_M_X64)
      asm volatile("pause" ::: "memory");
#elif defined(__aarch64__)
      asm volatile("yield" ::: "memory");
#endif
      continue;
    }

    const auto shock = engine.shock_ring.get(read_seq);

    // ── COMMAND MULTIPLEXER ─────────────────────────────────────
    if (shock.shock_type == 0xFF) [[unlikely]] {
      // COMMAND: SYSTEM RESET
      std::printf("[compute] SYSTEM RESET INITIATED.\n");
      load_market_binary(graph);
      optirisk::market::init_clob(clob);
      std::fill(prev_nav.begin(), prev_nav.end(), 0.0);
      std::fill(prev_defaulted.begin(), prev_defaulted.end(), 0);
      for (uint32_t i = 0; i < graph.num_nodes; ++i) {
        prev_nav[i] = graph.nodes.nav[i];
        prev_defaulted[i] = graph.nodes.is_defaulted[i];
      }
      tick_counter = 0;

    } else if (shock.shock_type == 0xFE) [[unlikely]] {
      // COMMAND: ON-DEMAND VaR
      uint32_t target = shock.target_node_id;
      std::printf("[compute] VaR Requested for Node %u\n", target);

      const auto var_result =
          optirisk::compute::run_monte_carlo_var(graph, shock);

      optirisk::network::VaRReport var_rep{};
      var_rep.target_node = target;
      var_rep.paths_run = 1024; // Assuming 1024 paths
      var_rep.var_95 = var_result.var_95[target];
      var_rep.expected_loss = var_result.expected[target];
      // Simulate/copy histogram buckets here if your engine populates them

      udp.broadcast_var(var_rep);

    } else [[likely]] {
      if (!valid_shock(shock)) [[unlikely]] {
        std::printf("[compute] rejected invalid shock deltas\n");
      } else {
        // COMMAND: STANDARD SHOCK / CASCADE
        const auto stats =
            optirisk::compute::run_cascade_tick(clob, graph, options, shock);

        // SYSTEMIC BROADCAST (Lifting the Hero Filter)
        // Loop unrolled organically by compiler. Hits contiguous memory.
        for (uint32_t i = 0; i < graph.num_nodes; ++i) {
          // Only broadcast if the node took financial damage or defaulted
          if (graph.nodes.nav[i] != prev_nav[i] ||
          graph.nodes.is_defaulted[i] != prev_defaulted[i] ||
          graph.nodes.risk_score[i] != prev_risk[i]) {

            auto tick_seq_num =
                engine.tick_ring.claim(engine.broadcast_cursor, g_running);
            if (tick_seq_num == UINT64_MAX) [[unlikely]]
              break;

            auto &tick = engine.tick_ring.get(tick_seq_num);
            tick.node_id = i;
            tick.risk_score = graph.nodes.risk_score[i];
            tick.nav = graph.nodes.nav[i];
            tick.exposure_total = graph.nodes.total_assets[i];
            tick.delta_nav = graph.nodes.nav[i] - prev_nav[i];
            tick.delta_exposure = 0.0;
            tick.is_defaulted = graph.nodes.is_defaulted[i] != 0 ? 1 : 0;
            tick.hub_id = static_cast<uint8_t>(graph.nodes.hub_id[i]);
            tick.cascade_depth =
                static_cast<uint8_t>(std::min(stats.total_defaults, 255u));
            tick.tick_seq = tick_counter++;
            tick.compute_cycles = stats.compute_cycles;

            engine.tick_ring.publish(tick_seq_num);

            // Update tracker
            prev_nav[i] = graph.nodes.nav[i];
            prev_defaulted[i] = graph.nodes.is_defaulted[i];
            prev_risk[i] = graph.nodes.risk_score[i];
          }
        }
      }
    }

    clob.flip_buffers();
    ++read_seq;
    engine.compute_cursor.value.store(read_seq, std::memory_order_release);
    ++engine.compute_count;
  }
}

// ── Thread 3: Broadcast (Binary Publisher) ─────────────────────────
static void broadcast_thread(optirisk::concurrency::DisruptorEngine &engine,
                             optirisk::network::WsListener &listener,
                             optirisk::market::CLOBEngine &clob,
                             optirisk::network::UdpPublisher &udp) {
  optirisk::utils::pin_thread_to_core(3); // Isolate Exgress Network to Core 3

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

    const auto &tick = engine.tick_ring.get(read_seq);

    // Binary WebSocket broadcast (TCP OUCH)
    listener.broadcast_tick(tick);

    // UDP Multicast broadcast (UDP ITCH)
    udp.broadcast_tick(tick);

    // Iterate BBO delta array and blast 10-byte limits via direct
    // scatter-gather
    auto bbo_deltas = clob.get_inactive_read_buffer();
    if (!bbo_deltas.empty()) {
      udp.broadcast_bbo(bbo_deltas);
    }

    auto now = std::chrono::steady_clock::now();
    auto elapsed =
        std::chrono::duration_cast<std::chrono::seconds>(now - last_report);
    if (elapsed.count() >= 5) [[unlikely]] {
      uint64_t delta = read_seq - last_report_seq;
      double throughput = (elapsed.count() > 0)
                              ? static_cast<double>(delta) /
                                    static_cast<double>(elapsed.count())
                              : 0.0;

      std::printf("[broadcast] tick=%u node=%u risk=%.3f nav=%.0f "
                  "| %.0f msgs/sec | drops=%llu | cycles=%llu "
                  "| net=%llu comp=%llu bcast=%llu\n",
                  tick.tick_seq, tick.node_id,
                  static_cast<double>(tick.risk_score), tick.nav, throughput,
                  static_cast<unsigned long long>(listener.dropped_tick_frames()),
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
static void load_market_binary(optirisk::memory::CSRGraph &graph) {
  graph.clear();

  FILE *fp = std::fopen("../optirisk_memory.bin", "rb");
  if (!fp) {
    std::fprintf(stderr, "FATAL: Could not open ../optirisk_memory.bin. Run "
                         "python scripts/infer_network.py first.\n");
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
  std::signal(SIGINT, signal_handler);
  std::signal(SIGTERM, signal_handler);

  constexpr uint32_t NUM_NODES = 500;

  std::printf("═══════════════════════════════════════════\n");
  std::printf("  OptiRisk — Counterparty Risk Simulator\n");
  std::printf(
      "  Nodes: %u | Ring: %zu slots × %zu bytes\n", NUM_NODES,
      optirisk::concurrency::RING_SIZE,
      sizeof(
          optirisk::concurrency::EventSlot<optirisk::network::ShockPayload>));
  std::printf("═══════════════════════════════════════════\n");

  // Build the counterparty graph (one-time heap-free init)
  static optirisk::memory::CSRGraph graph; // static → .bss, zero-initialized
  load_market_binary(graph);
  std::printf("[init] Graph loaded: %u nodes, %u edges\n", graph.num_nodes,
              graph.num_edges);
  std::printf("[init] Hero Firm ID dynamically mapped to: %u\n", HERO_FIRM_ID);

  // Initialize CLOB
  static optirisk::market::CLOBEngine clob;
  optirisk::market::init_clob(clob);
  std::printf("[init] CLOB Engine armed with realistic depth\n");

  // Initialize OptionsBook
  static optirisk::memory::OptionsBook options;
  optirisk::memory::init_options_book(options);
  std::printf("[init] Options Engine seeded with volatile Call/Put exposure\n");

  // Create disruptor engine (static → .bss)
  static optirisk::concurrency::DisruptorEngine engine{};
  std::printf("[init] DisruptorEngine: %zu KB total ring memory\n",
              (sizeof(engine.shock_ring) + sizeof(engine.tick_ring)) / 1024);

  // Initialize UDP Multicast Publisher
  static optirisk::network::UdpPublisher udp{"239.255.0.1", 9090};

  // WsListener parsing callback
  auto on_shock = [](const optirisk::network::ShockPayload &shock) {
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
  std::thread t1(network_thread, std::ref(engine), std::ref(listener));
  std::thread t2(compute_thread, std::ref(engine), std::ref(graph),
                 std::ref(options), std::ref(clob), std::ref(udp));
  std::thread t3(broadcast_thread, std::ref(engine), std::ref(listener),
                 std::ref(clob), std::ref(udp));

  std::printf(
      "[main] Pipeline running on WS port 8080. Press Ctrl+C to stop.\n\n");

  t1.join();
  t2.join();
  t3.join();

  std::printf("\n[main] Shutdown complete.\n");
  return 0;
}
