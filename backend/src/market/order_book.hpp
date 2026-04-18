#pragma once
// ============================================================================
// order_book.hpp — Central Limit Order Book (CLOB) Engine
//
// Depth-based liquidation simulator for 5 global asset classes.
// Zero dynamic allocation. Fully cache-aligned std::array structures.
// Models price slippage under massive liquidation loads.
//
// Asset Classes & Baselines:
//   Equities    (SPY) ~ $500.00
//   Real Estate (VNQ) ~ $80.00
//   Crypto      (BTC) ~ $60000.00
//   Treasuries  (TLT) ~ $90.00
//   Corp Bonds  (LQD) ~ $105.00
// ============================================================================

#include <cstdint>
#include <array>
#include <algorithm>
#include <span>

#include "network/protocol.hpp"
#include <cmath>
#include <atomic>

namespace optirisk::market {

inline constexpr uint32_t NUM_ASSETS = 5;
inline constexpr uint32_t BOOK_MAX_DEPTH = 256;
inline constexpr uint32_t BBO_BUFFER_SIZE = 2048;

enum class AssetClass : uint8_t {
    Equities   = 0,
    RealEstate = 1,
    Crypto     = 2,
    Treasuries = 3,
    CorpBonds  = 4
};

struct alignas(64) PriceLevel {
    double price;  // Price point in USD
    double depth;  // Available liquidity (number of units) at this price
};

struct FillResult {
    double avg_fill_price;   // Average execution price
    double total_proceeds;   // Total USD recovered (or spent)
    double slippage_pct;     // Execution penalty vs original mid_price
    double new_mid_price;    // Updated mid price after execution
    uint32_t levels_consumed;// Number of depth limits broken
};

// ── Single Asset Order Book ───────────────────────────────────────────────
struct alignas(64) OrderBook {
    // Arrays representing the bid limit orders and ask limit orders.
    // bids are sorted descending (best bid is bids[bids_head]).
    // asks are sorted ascending (best ask is asks[asks_head]).
    std::array<PriceLevel, BOOK_MAX_DEPTH> bids{};
    std::array<PriceLevel, BOOK_MAX_DEPTH> asks{};
    
    uint32_t num_bids = 0;
    uint32_t num_asks = 0;
    
    uint32_t bids_head = 0; // Index of current best bid
    uint32_t asks_head = 0; // Index of current best ask

    double last_price = 0.0;
    double original_baseline = 0.0;

    __attribute__((always_inline))
    inline double mid_price() const noexcept {
        if (bids_head < num_bids && asks_head < num_asks) {
            return (bids[bids_head].price + asks[asks_head].price) * 0.5;
        }
        return last_price;
    }

    // Sell 'units' by walking down the bid stack.
    // Simulates a forced liquidation eating into market liquidity.
    __attribute__((always_inline))
    inline FillResult market_sell(double units, 
                                  optirisk::network::BboUpdate* bbo_buffer = nullptr, 
                                  uint32_t* bbo_count = nullptr, 
                                  uint8_t asset_id = 0) noexcept {
        if (bids_head >= num_bids || units <= 0.0) [[unlikely]] {
            return {0.0, 0.0, 0.0, last_price, 0};
        }

        const double old_mid = mid_price();
        double remaining_units = units;
        double total_proceeds = 0.0;
        uint32_t starting_head = bids_head;

        while (remaining_units > 0.0 && bids_head < num_bids) {
            PriceLevel& level = bids[bids_head];
            double fill = std::min(remaining_units, level.depth);
            
            level.depth -= fill;
            
            if (bbo_buffer && bbo_count && *bbo_count < BBO_BUFFER_SIZE) {
                bbo_buffer[*bbo_count] = { asset_id, 0 /*Bid*/, static_cast<float>(level.price), static_cast<float>(level.depth), {0} };
                (*bbo_count)++;
            }

            remaining_units -= fill;
            total_proceeds += fill * level.price;
            last_price = level.price;

            if (level.depth <= 0.0) {
                bids_head++; // Level consumed, move to next best bid
            }
        }

        double filled_units = units - remaining_units;
        double avg_fill = (filled_units > 0.0) ? (total_proceeds / filled_units) : 0.0;
        double current_mid = mid_price();
        double slippage = 0.0;
        if (old_mid > 0.0 && avg_fill > 0.0) {
           slippage = (old_mid - avg_fill) / old_mid;
        }

        return FillResult{
            avg_fill,
            total_proceeds,
            std::max(0.0, slippage),
            current_mid,
            bids_head - starting_head
        };
    }

    // Buy 'units' by walking up the ask stack.
    // Used by 'Sword' action (short covering).
    __attribute__((always_inline))
    inline FillResult market_buy(double units,
                                 optirisk::network::BboUpdate* bbo_buffer = nullptr,
                                 uint32_t* bbo_count = nullptr,
                                 uint8_t asset_id = 0) noexcept {
        if (asks_head >= num_asks || units <= 0.0) [[unlikely]] {
            return {0.0, 0.0, 0.0, last_price, 0};
        }

        const double old_mid = mid_price();
        double remaining_units = units;
        double total_cost = 0.0;
        uint32_t starting_head = asks_head;

        while (remaining_units > 0.0 && asks_head < num_asks) {
            PriceLevel& level = asks[asks_head];
            double fill = std::min(remaining_units, level.depth);
            
            level.depth -= fill;
            
            if (bbo_buffer && bbo_count && *bbo_count < BBO_BUFFER_SIZE) {
                bbo_buffer[*bbo_count] = { asset_id, 1 /*Ask*/, static_cast<float>(level.price), static_cast<float>(level.depth), {0} };
                (*bbo_count)++;
            }

            remaining_units -= fill;
            total_cost += fill * level.price;
            last_price = level.price;

            if (level.depth <= 0.0) {
                asks_head++;
            }
        }

        double filled_units = units - remaining_units;
        double avg_fill = (filled_units > 0.0) ? (total_cost / filled_units) : 0.0;
        double current_mid = mid_price();
        double slippage = 0.0;
        if (old_mid > 0.0 && avg_fill > 0.0) {
           slippage = (avg_fill - old_mid) / old_mid;
        }

        return FillResult{
            avg_fill,
            total_cost,
            std::max(0.0, slippage),
            current_mid,
            asks_head - starting_head
        };
    }

    // Re-generates liquidity around the current mid price (e.g. market makers re-quoting).
    // Fills up to 256 levels on each side.
    void refresh_liquidity(double base_depth) noexcept {
        const double ref_price = mid_price();
        const double tick_size = std::max(0.01, ref_price * 0.0005); // 5 bps tick

        bids_head = 0;
        asks_head = 0;
        num_bids = BOOK_MAX_DEPTH;
        num_asks = BOOK_MAX_DEPTH;

        for (uint32_t i = 0; i < BOOK_MAX_DEPTH; ++i) {
            // Price drops as we go deeper into the bid book
            bids[i] = { ref_price - tick_size * (i + 1), base_depth * (1.0 + i * 0.1) };
            
            // Price increases as we go deeper into the ask book
            asks[i] = { ref_price + tick_size * (i + 1), base_depth * (1.0 + i * 0.1) };
        }
        last_price = ref_price;
    }
    
    // Hard macroeconomic shock — moves the whole book down/up by a %.
    void apply_macro_shock(double delta) noexcept {
        double multiplier = 1.0 + delta;
        for (uint32_t i = bids_head; i < num_bids; ++i) bids[i].price *= multiplier;
        for (uint32_t i = asks_head; i < num_asks; ++i) asks[i].price *= multiplier;
        last_price *= multiplier;
    }
};

// ── Global CLOB Context ───────────────────────────────────────────────────
struct alignas(64) CLOBEngine {
    std::array<OrderBook, NUM_ASSETS> books;
    
    // ── Zero-Allocation Ping-Pong BBO Buffer ──────────────────────────────────
    // Double buffer allows uninterrupted compute while broadcasting
    alignas(64) std::array<optirisk::network::BboUpdate, BBO_BUFFER_SIZE> bbo_buffer[2]{};
    alignas(64) uint32_t bbo_count[2]{0, 0};
    
    // std::atomic enforces hard memory barriers across cores ensuring broadcast_thread
    // never reads a half-written packet stream.
    std::atomic<uint8_t> active_buffer_idx{0};

    // Called by compute_thread to swap the buffers
    inline void flip_buffers() noexcept {
        uint8_t current = active_buffer_idx.load(std::memory_order_relaxed);
        uint8_t next = (current + 1) % 2;
        bbo_count[next] = 0; // Clear the old inactive buffer before making it active
        active_buffer_idx.store(next, std::memory_order_release);
    }
    
    // Returns the currently active write buffer pointer and count ref
    inline void get_write_buffer(optirisk::network::BboUpdate** out_buf, uint32_t** out_count) noexcept {
        uint8_t current = active_buffer_idx.load(std::memory_order_relaxed);
        *out_buf = bbo_buffer[current].data();
        *out_count = &bbo_count[current];
    }
    
    // Returns the read-only inactive buffer for broadcast
    inline std::span<optirisk::network::BboUpdate> get_inactive_read_buffer() noexcept {
        uint8_t current = active_buffer_idx.load(std::memory_order_acquire);
        uint8_t inactive = (current + 1) % 2;
        return std::span<optirisk::network::BboUpdate>{bbo_buffer[inactive].data(), bbo_count[inactive]};
    }
};

// Initializes all order books with realistic baseline prices.
inline void init_clob(CLOBEngine& clob) noexcept {
    // Equities: SPY ~$500. Depth ~10,000 units at best bid
    clob.books[static_cast<uint8_t>(AssetClass::Equities)].last_price = 500.0;
    clob.books[static_cast<uint8_t>(AssetClass::Equities)].original_baseline = 500.0;
    clob.books[static_cast<uint8_t>(AssetClass::Equities)].refresh_liquidity(10000.0);

    // Real Estate: VNQ ~$80. Depth ~50,000 units
    clob.books[static_cast<uint8_t>(AssetClass::RealEstate)].last_price = 80.0;
    clob.books[static_cast<uint8_t>(AssetClass::RealEstate)].original_baseline = 80.0;
    clob.books[static_cast<uint8_t>(AssetClass::RealEstate)].refresh_liquidity(50000.0);

    // Crypto: BTC ~$60K. Depth ~10 units
    clob.books[static_cast<uint8_t>(AssetClass::Crypto)].last_price = 60000.0;
    clob.books[static_cast<uint8_t>(AssetClass::Crypto)].original_baseline = 60000.0;
    clob.books[static_cast<uint8_t>(AssetClass::Crypto)].refresh_liquidity(10.0);

    // Treasuries: TLT ~$90. Depth ~100,000 units
    clob.books[static_cast<uint8_t>(AssetClass::Treasuries)].last_price = 90.0;
    clob.books[static_cast<uint8_t>(AssetClass::Treasuries)].original_baseline = 90.0;
    clob.books[static_cast<uint8_t>(AssetClass::Treasuries)].refresh_liquidity(100000.0);

    // Corp Bonds: LQD ~$105. Depth ~25,000 units
    clob.books[static_cast<uint8_t>(AssetClass::CorpBonds)].last_price = 105.0;
    clob.books[static_cast<uint8_t>(AssetClass::CorpBonds)].original_baseline = 105.0;
    clob.books[static_cast<uint8_t>(AssetClass::CorpBonds)].refresh_liquidity(25000.0);
}

} // namespace optirisk::market
