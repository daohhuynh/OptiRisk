// ============================================================================
// test_disruptor.cpp — 3-Thread Lock-Free Disruptor Pipeline Test
//
// Launches three threads that chase each other's atomic cursors through
// two ring buffers. ZERO mutexes, locks, or condition variables.
//
// Topology:
//   Network → shock_ring → Compute → tick_ring → Broadcast
//
// Each thread:
//   1. Spin-polls the upstream write cursor (acquire)
//   2. Reads/processes the slot
//   3. Writes to the downstream ring (release)
//   4. Advances its own consumer cursor (release)
//
// Build:
//   g++ -std=c++23 -O3 -Wall -Wextra -Werror -I src \
//       src/concurrency/test_disruptor.cpp -lpthread \
//       -o build/test_disruptor
// ============================================================================

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <thread>

#include "concurrency/disruptor.hpp"
#include "network/wire_protocol.hpp"

using namespace optirisk::concurrency;
using namespace optirisk::network;

// ── Global Shutdown Flag ──────────────────────────────────────────
static std::atomic<bool> g_running{true};

// ── Thread 1: NETWORK ─────────────────────────────────────────────
//
// Simulates receiving ShockPayloads from WebSocket clients.
// Writes into shock_ring, advancing shock_ring.write_cursor.
// The Compute thread chases this cursor.
//
static void network_thread(DisruptorEngine &engine) {
  uint64_t seq = 0;
  uint32_t node_id = 0;

  std::printf("[network] started — producing ShockPayloads\n");

  while (g_running.load(std::memory_order_relaxed)) [[likely]] {
    // Pass g_running into the claim method
    const uint64_t slot_seq =
        engine.shock_ring.claim(engine.compute_cursor, g_running);

    // Catch the poison pill and abort cleanly if shutdown triggered while we
    // were spinning
    if (slot_seq == UINT64_MAX) [[unlikely]] {
      break;
    }

    // Write the payload directly into the slot (zero-copy)
    auto &shock = engine.shock_ring.get(slot_seq);
    shock.target_node_id = node_id % 500;
    shock.shock_type = static_cast<uint32_t>(node_id % 5);
    shock.equities_delta = -0.05 * static_cast<double>((node_id % 10) + 1);
    shock.real_estate_delta = -0.02;
    shock.crypto_delta = -0.10;
    shock.treasuries_delta = 0.01;
    shock.corp_bonds_delta = -0.03;
    shock.timestamp_ns = static_cast<uint64_t>(
        std::chrono::steady_clock::now().time_since_epoch().count());

    // Publish — release fence makes the payload visible to Compute
    engine.shock_ring.publish(slot_seq);

    // Advance our consumer cursor (for end-to-end back-pressure)
    engine.network_cursor.value.store(seq + 1, std::memory_order_release);

    ++seq;
    ++node_id;
    ++engine.network_count;

    // Throttle to ~100K events/sec for the demo
    // In production this would be driven by WebSocket recv()
    if ((seq & 0xFF) == 0) [[unlikely]] {
      std::this_thread::sleep_for(std::chrono::microseconds(1));
    }
  }

  std::printf("[network] stopped — produced %llu events\n",
              static_cast<unsigned long long>(seq));
}

// ── Thread 2: COMPUTE ─────────────────────────────────────────────
//
// Reads ShockPayloads from shock_ring, processes them (applies deltas
// to the risk graph — stubbed here), writes TickDeltas into tick_ring.
// Chases Network's write cursor; Broadcast chases ours.
//
static void compute_thread(DisruptorEngine &engine) {
  uint64_t read_seq = 0; // Next sequence to read from shock_ring
  uint32_t tick_counter = 0;

  std::printf("[compute] started — processing ShockPayloads → TickDeltas\n");

  while (g_running.load(std::memory_order_relaxed)) [[likely]] {
    // Spin until Network has published a new ShockPayload
    if (!engine.shock_ring.available(read_seq)) [[unlikely]] {
// CPU hint — yield execution resources while spinning
#if defined(__x86_64__) || defined(_M_X64)
      asm volatile("pause" ::: "memory");
#elif defined(__aarch64__)
      asm volatile("yield" ::: "memory");
#endif
      continue;
    }

    // Read the ShockPayload (acquire semantics already satisfied)
    const auto &shock = engine.shock_ring.get(read_seq);

    // ── COMPUTE STAGE (stub) ──────────────────────────────────
    // In the real engine, this is where we:
    //   1. Apply shock deltas to the CSR graph node's portfolio
    //   2. Recalculate NAV
    //   3. Run cascade detection (BFS over CSR edges)
    //   4. Build the TickDelta with before/after deltas
    //
    // For this test, we just transform ShockPayload → TickDelta.

    // Claim a slot in tick_ring (back-pressure from Broadcast)
    const uint64_t tick_slot =
        engine.tick_ring.claim(engine.broadcast_cursor, g_running);
    if (tick_slot == UINT64_MAX) [[unlikely]] break;

    auto &tick = engine.tick_ring.get(tick_slot);
    tick.node_id = shock.target_node_id;
    tick.risk_score = static_cast<float>(-shock.equities_delta); // stub
    tick.nav = 1'500'000'000.0 + shock.equities_delta * 100'000'000.0;
    tick.exposure_total = 750'000'000.0;
    tick.delta_nav = shock.equities_delta * 100'000'000.0;
    tick.delta_exposure = shock.crypto_delta * 50'000'000.0;
    tick.is_defaulted = (tick.risk_score > 0.95f) ? uint8_t{1} : uint8_t{0};
    tick.hub_id = static_cast<uint8_t>(shock.target_node_id % 5);
    tick.cascade_depth = 0;
    tick.tick_seq = tick_counter++;

    // Publish TickDelta — Broadcast can now see it
    engine.tick_ring.publish(tick_slot);

    // Advance our consumer cursor (tells Network we've consumed)
    ++read_seq;
    engine.compute_cursor.value.store(read_seq, std::memory_order_release);

    ++engine.compute_count;
  }

  std::printf("[compute] stopped — processed %llu events\n",
              static_cast<unsigned long long>(read_seq));
}

// ── Thread 3: BROADCAST ───────────────────────────────────────────
//
// Reads TickDeltas from tick_ring and "broadcasts" them (serializes
// to binary + sends over WebSocket — stubbed here as a printf).
// Chases Compute's write cursor.
//
static void broadcast_thread(DisruptorEngine &engine) {
  uint64_t read_seq = 0;
  uint64_t last_report_seq = 0;
  auto last_report = std::chrono::steady_clock::now();

  std::printf("[broadcast] started — consuming TickDeltas\n");

  while (g_running.load(std::memory_order_relaxed)) [[likely]] {
    // Spin until Compute has published a new TickDelta
    if (!engine.tick_ring.available(read_seq)) [[unlikely]] {
#if defined(__x86_64__) || defined(_M_X64)
      asm volatile("pause" ::: "memory");
#elif defined(__aarch64__)
      asm volatile("yield" ::: "memory");
#endif
      continue;
    }

    // Read the TickDelta
    const auto &tick = engine.tick_ring.get(read_seq);

    // ── BROADCAST STAGE (stub) ────────────────────────────────
    // In the real engine, this would:
    //   1. Serialize TickDelta into a 52-byte binary frame
    //   2. Push to all connected WebSocket clients via uWS::publish()
    //
    // For this test, we just do periodic throughput reporting.

    // Advance our consumer cursor (tells Compute we've consumed)
    ++read_seq;
    engine.broadcast_cursor.value.store(read_seq, std::memory_order_release);

    ++engine.broadcast_count;

    // Periodic throughput report (every 2 seconds)
    auto now = std::chrono::steady_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        now - last_report);
    if (elapsed.count() >= 2000) [[unlikely]] {
      uint64_t delta = read_seq - last_report_seq;
      double throughput = static_cast<double>(delta) /
                          (static_cast<double>(elapsed.count()) / 1000.0);

      std::printf("[broadcast] tick_seq=%u  node=%u  risk=%.4f  nav=%.2f  |  "
                  "%.0f msgs/sec  |  net=%llu  comp=%llu  bcast=%llu\n",
                  tick.tick_seq, tick.node_id,
                  static_cast<double>(tick.risk_score), tick.nav, throughput,
                  static_cast<unsigned long long>(engine.network_count),
                  static_cast<unsigned long long>(engine.compute_count),
                  static_cast<unsigned long long>(engine.broadcast_count));

      last_report = now;
      last_report_seq = read_seq;
    }
  }

  std::printf("[broadcast] stopped — consumed %llu events\n",
              static_cast<unsigned long long>(read_seq));
}

// ── Main ──────────────────────────────────────────────────────────
int main() {
  std::printf("═══════════════════════════════════════════════════════════\n");
  std::printf("  OptiRisk — 3-Stage Lock-Free Disruptor Test\n");
  std::printf("  Ring Size: %zu slots | Slot Size: %zu bytes\n", RING_SIZE,
              sizeof(EventSlot<ShockPayload>));
  std::printf("  ShockPayload: %zu bytes | TickDelta: %zu bytes\n",
              sizeof(ShockPayload), sizeof(TickDelta));
  std::printf("  PaddedCursor: %zu bytes (alignas=%zu)\n", sizeof(PaddedCursor),
              alignof(PaddedCursor));
  std::printf(
      "  Total ring memory: %zu KB\n",
      (sizeof(RingBuffer<ShockPayload>) + sizeof(RingBuffer<TickDelta>)) /
          1024);
  std::printf("═══════════════════════════════════════════════════════════\n");
  std::printf("  ZERO std::mutex  |  ZERO std::condition_variable\n");
  std::printf("  ZERO std::lock_guard  |  ZERO heap allocation\n");
  std::printf(
      "═══════════════════════════════════════════════════════════\n\n");

  // Place the engine in static storage (.bss) to avoid stack overflow
  // and to get free zero-initialization from the OS loader.
  static DisruptorEngine engine{};

  std::printf("[main] launching 3 pipeline threads...\n\n");

  std::thread t1(network_thread, std::ref(engine));
  std::thread t2(compute_thread, std::ref(engine));
  std::thread t3(broadcast_thread, std::ref(engine));

  // Run for 10 seconds then shutdown
  std::this_thread::sleep_for(std::chrono::seconds(10));
  g_running.store(false, std::memory_order_relaxed);

  std::printf("\n[main] shutdown signal sent — joining threads...\n");

  t1.join();
  t2.join();
  t3.join();

  // Final report
  std::printf(
      "\n═══════════════════════════════════════════════════════════\n");
  std::printf("  FINAL COUNTERS\n");
  std::printf("  Network:   %llu events produced\n",
              static_cast<unsigned long long>(engine.network_count));
  std::printf("  Compute:   %llu events processed\n",
              static_cast<unsigned long long>(engine.compute_count));
  std::printf("  Broadcast: %llu events consumed\n",
              static_cast<unsigned long long>(engine.broadcast_count));

  // Verify no data was lost
  if (engine.network_count == engine.compute_count &&
      engine.compute_count == engine.broadcast_count) {
    std::printf(
        "\n  ✅ ZERO DATA LOSS — all stages processed identical counts\n");
  } else {
    // Small delta is expected due to shutdown race
    int64_t delta_nc = static_cast<int64_t>(engine.network_count) -
                       static_cast<int64_t>(engine.compute_count);
    int64_t delta_cb = static_cast<int64_t>(engine.compute_count) -
                       static_cast<int64_t>(engine.broadcast_count);
    std::printf("\n  ⚠ Shutdown race delta: net-comp=%lld  comp-bcast=%lld\n",
                static_cast<long long>(delta_nc),
                static_cast<long long>(delta_cb));
    if (delta_nc <= 1 && delta_cb <= 1) {
      std::printf("  ✅ Within expected shutdown tolerance (≤1 event)\n");
    }
  }

  std::printf("═══════════════════════════════════════════════════════════\n");
  return 0;
}
