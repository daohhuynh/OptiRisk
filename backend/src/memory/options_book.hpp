#pragma once
// ============================================================================
// options_book.hpp — Non-Linear Derivatives Book
//
// Parallel SoA to track 500 nodes' European Options exposure.
// Uses `float` instead of `double` (unlike CSRGraph linear arrays) to hit   
// exactly 8 lanes per cycle on AVX2 (_mm256_*_ps) and maximize VaR throughput.
// ============================================================================

#include <cstdint>
#include <array>
#include "memory/csr_graph.hpp"

namespace optirisk::memory {

struct alignas(64) OptionsBook {
    // 8-Lane SIMD Vectors (32-bit float)
    alignas(64) std::array<float, MAX_NODES> strikes;
    alignas(64) std::array<float, MAX_NODES> expiries; // Years (e.g. 0.5 = 6 months)
    alignas(64) std::array<float, MAX_NODES> types;    //  1.0f = Call, -1.0f = Put
    alignas(64) std::array<float, MAX_NODES> positions;// Contracts held
    alignas(64) std::array<float, MAX_NODES> iv;       // $\sigma$
    alignas(64) std::array<float, MAX_NODES> rates;    // $r$ risk-free
    
    // State buffer — previous round's Black-Scholes Delta per node
    alignas(64) std::array<float, MAX_NODES> last_delta;
};

// Seed synthetic options positions designed to trigger violent Gamma Squeezes
inline void init_options_book(OptionsBook& book) noexcept {
    book.strikes.fill(0.0f);
    book.expiries.fill(0.5f);
    book.types.fill(0.0f);
    book.positions.fill(0.0f);
    book.iv.fill(0.20f);       // Baseline 20% VIX
    book.rates.fill(0.05f);    // 5% Risk Free Return
    book.last_delta.fill(0.0f);

    // Nodes 10 -> 49: Naked Call Writers (Short Gamma)
    for (uint32_t i = 10; i < 50; ++i) {
        book.strikes[i] = 520.0f; // Slightly Out-of-the-Money calls (Equities ≈ 500)
        book.types[i] = 1.0f;     // Call
        // Negative position = writing naked contracts. Huge short gamma exposure!
        book.positions[i] = -50000.0f; 
    }

    // Nodes 50 -> 89: Massive Put Sellers (Vulnerability to Flash Crash)
    for (uint32_t i = 50; i < 90; ++i) {
        book.strikes[i] = 450.0f; // Deep Out-of-the-Money puts (Equities ≈ 500)
        book.types[i] = -1.0f;    // Put
        book.positions[i] = -100000.0f; // Huge block. If Eq falls to 450, forced covering destroys market
    }
}

} // namespace optirisk::memory
