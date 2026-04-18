#pragma once
// ============================================================================
// disruptor.hpp — Lock-Free LMAX Disruptor Ring Buffer
//
// Single-producer, multi-consumer ring buffer for the 3-thread pipeline:
//   Thread 1 (Ingest)  → writes market events
//   Thread 2 (Compute) → reads events, writes risk snapshots
//   Thread 3 (Publish) → reads snapshots, serializes to WebSocket
//
// Zero heap allocation. Cache-line aligned. Wait-free on the fast path.
// ============================================================================

#include <array>
#include <atomic>
#include <cstdint>
#include <cstddef>
#include <new>       // std::hardware_destructive_interference_size
#include <optional>

namespace optirisk::concurrency {

// ── Cache-Line Size ────────────────────────────────────────────────
#ifdef __cpp_lib_hardware_interference_size
    inline constexpr std::size_t CACHE_LINE = std::hardware_destructive_interference_size;
#else
    inline constexpr std::size_t CACHE_LINE = 64;
#endif

// ── Padded Atomic Sequence Counter ─────────────────────────────────
// Prevents false sharing between producer and consumer cursors.
struct alignas(CACHE_LINE) PaddedCursor {
    std::atomic<int64_t> sequence{-1};
    // Padding fills the rest of the cache line
    char _pad[CACHE_LINE - sizeof(std::atomic<int64_t>)];
};

static_assert(sizeof(PaddedCursor) == CACHE_LINE,
              "PaddedCursor must occupy exactly one cache line");

// ── Ring Buffer Entry ──────────────────────────────────────────────
// Each slot is cache-line aligned to prevent false sharing between
// adjacent entries being written/read by different threads.
template <typename T>
struct alignas(CACHE_LINE) Slot {
    T       data{};
    int64_t sequence = -1;  // Published sequence number for this slot
};

// ── Disruptor Ring Buffer ──────────────────────────────────────────
// `Size` MUST be a power of two for fast modulo via bitmask.
//
// Usage:
//   Disruptor<MarketEvent, 1024> ring;
//   // Producer:
//   auto seq = ring.claim();
//   ring.get(seq) = event;
//   ring.publish(seq);
//   // Consumer:
//   auto evt = ring.try_read(consumer_cursor);
//
template <typename T, std::size_t Size>
    requires (Size > 0 && (Size & (Size - 1)) == 0)  // Power-of-two constraint
class Disruptor {
public:
    static constexpr std::size_t BUFFER_SIZE = Size;
    static constexpr std::size_t INDEX_MASK  = Size - 1;

    Disruptor() = default;

    // Non-copyable, non-movable (contains atomics)
    Disruptor(const Disruptor&)            = delete;
    Disruptor& operator=(const Disruptor&) = delete;
    Disruptor(Disruptor&&)                 = delete;
    Disruptor& operator=(Disruptor&&)      = delete;

    // ── Producer API ───────────────────────────────────────────────

    // Claim the next slot. Returns the sequence number.
    // Single-producer only — no CAS loop needed.
    [[nodiscard]] int64_t claim() noexcept {
        return producer_.sequence.fetch_add(1, std::memory_order_relaxed) + 1;
    }

    // Get a mutable reference to the slot at `seq`.
    [[nodiscard]] T& get(int64_t seq) noexcept {
        return buffer_[static_cast<std::size_t>(seq) & INDEX_MASK].data;
    }

    // Publish a slot, making it visible to consumers.
    // Uses release semantics to ensure the data write is visible.
    void publish(int64_t seq) noexcept {
        buffer_[static_cast<std::size_t>(seq) & INDEX_MASK].sequence
            = seq;
        // Store-release on the cursor so consumers see the update.
        cursor_.sequence.store(seq, std::memory_order_release);
    }

    // ── Consumer API ───────────────────────────────────────────────

    // Try to read the next event after `last_seen`.
    // Returns the data if available, or std::nullopt if the consumer
    // has caught up to the producer.
    [[nodiscard]] std::optional<T> try_read(int64_t& last_seen) const noexcept {
        const int64_t next = last_seen + 1;
        const int64_t available = cursor_.sequence.load(std::memory_order_acquire);

        if (next > available) {
            return std::nullopt;  // Nothing new to read
        }

        const auto& slot = buffer_[static_cast<std::size_t>(next) & INDEX_MASK];

        // Spin-wait until this specific slot is published.
        // In practice this is instant since cursor >= next.
        while (slot.sequence < next) {
            // CPU hint — reduce power & allow other hyperthreads
            #if defined(__x86_64__) || defined(_M_X64)
                asm volatile("pause" ::: "memory");
            #elif defined(__aarch64__)
                asm volatile("yield" ::: "memory");
            #endif
        }

        last_seen = next;
        return slot.data;
    }

    // Get the last published sequence number.
    [[nodiscard]] int64_t published_cursor() const noexcept {
        return cursor_.sequence.load(std::memory_order_acquire);
    }

private:
    // ── Data Members (ordered to minimize false sharing) ───────────
    alignas(CACHE_LINE) std::array<Slot<T>, Size> buffer_{};
    PaddedCursor cursor_{};    // Last published sequence (read by consumers)
    PaddedCursor producer_{};  // Next claimable sequence (written by producer only)
};

// ── Pre-configured Pipeline Sizes ──────────────────────────────────
// 4096 slots = 4K entries. At ~16 bytes per event, this is 64KB —
// fits comfortably in L1 cache.
inline constexpr std::size_t PIPELINE_RING_SIZE = 4096;

} // namespace optirisk::concurrency
