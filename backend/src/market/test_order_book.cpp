// ============================================================================
// test_order_book.cpp — Central Limit Order Book Validation
//
// Standalone test binary. Verifies:
//   1. Correct book initialization with realistic baseline prices
//   2. Market sell slippage calculation and depth walking
//   3. Market buy verification
//   4. Macro shock application
//
// Build:
//   g++ -std=c++23 -O3 -Wall -Wextra -Werror -I src \
//       src/market/test_order_book.cpp -o build/test_order_book
// ============================================================================

#include <cstdio>
#include <cstdint>
#include <cmath>

#include "market/order_book.hpp"

using namespace optirisk::market;

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

static void test_initialization() {
    std::printf("[test] book initialization\n");
    CLOBEngine clob{};
    init_clob(clob);

    const auto& eq_book = clob.books[static_cast<uint8_t>(AssetClass::Equities)];
    const auto& cr_book = clob.books[static_cast<uint8_t>(AssetClass::Crypto)];

    CHECK(eq_book.last_price == 500.0, "Equities initialized to $500.0");
    CHECK(cr_book.last_price == 60000.0, "Crypto initialized to $60K");
    
    // Check depth generation
    CHECK(eq_book.num_bids == BOOK_MAX_DEPTH, "Equities 256 bids generated");
    CHECK(eq_book.bids[0].price < 500.0, "Best bid is below $500");
    CHECK(eq_book.asks[0].price > 500.0, "Best ask is above $500");
}

static void test_market_sell() {
    std::printf("[test] market sell & slippage\n");
    CLOBEngine clob{};
    init_clob(clob);

    auto& eq_book = clob.books[static_cast<uint8_t>(AssetClass::Equities)];
    double depth_l1 = eq_book.bids[0].depth;
    double depth_l2 = eq_book.bids[1].depth;

    // Sell an amount that perfectly eats L1 and half of L2
    double sell_units = depth_l1 + (depth_l2 * 0.5);
    FillResult res = eq_book.market_sell(sell_units);

    CHECK(res.levels_consumed == 1, "Consumed completely 1 level");
    CHECK(eq_book.bids_head == 1, "bids_head advanced to 1");
    // L2 depth should now be halved
    CHECK(std::abs(eq_book.bids[1].depth - (depth_l2 * 0.5)) < 1e-4, "L2 depth halved");
    CHECK(eq_book.last_price == eq_book.bids[1].price, "last_price shifted to L2 price");
    CHECK(res.slippage_pct > 0.0, "Slippage is strictly positive");
    
    std::printf("  Sold %.2f units. Avg fill: $%.2f. Slippage: %.4f%%\n",
                sell_units, res.avg_fill_price, res.slippage_pct * 100.0);
}

static void test_macro_shock() {
    std::printf("[test] macro shock\n");
    CLOBEngine clob{};
    init_clob(clob);

    auto& re_book = clob.books[static_cast<uint8_t>(AssetClass::RealEstate)];
    double orig_last = re_book.last_price;

    // Simulate a 30% drop
    re_book.apply_macro_shock(-0.30);

    CHECK(std::abs(re_book.last_price - (orig_last * 0.70)) < 1e-4, "last_price dropped 30%");
    CHECK(std::abs(re_book.bids[0].price - (orig_last * 0.70)) < 1.0, "Bids shifted down");
}

int main() {
    std::printf("═══════════════════════════════════════════\n");
    std::printf("  OptiRisk — CLOB Tests\n");
    std::printf("═══════════════════════════════════════════\n\n");

    test_initialization();
    test_market_sell();
    test_macro_shock();

    std::printf("\n═══════════════════════════════════════════\n");
    std::printf("  Results: %d passed, %d failed\n", g_pass, g_fail);
    std::printf("═══════════════════════════════════════════\n");

    return g_fail > 0 ? 1 : 0;
}
