#pragma once
// ============================================================================
// protocol.hpp — ITCH Protocol Simulator structs
//
// 16-byte aligned binary structs for zero-allocation UDP Multicast
// payload delivery. Optimized for direct memory mapping and AVX ingestion.
// ============================================================================

#include <cstdint>

namespace optirisk::network {

#pragma pack(push, 1)
struct BboUpdate {
    uint8_t asset_id;    // 0=Eq, 1=Re, etc.
    uint8_t side;        // 0=Bid, 1=Ask
    float   price;       // Mutated Price Level
    float   quantity;    // Remaining depth at this price
    uint8_t _padding[6]; // Absolute hardware 16-byte cache boundary
};
#pragma pack(pop)

static_assert(sizeof(BboUpdate) == 16, "BboUpdate must be exactly 16 bytes for proper hardware SIMD padding");

} // namespace optirisk::network
