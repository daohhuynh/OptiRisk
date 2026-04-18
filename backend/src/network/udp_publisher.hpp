#pragma once
// ============================================================================
// udp_publisher.hpp — Institutional ITCH-style UDP Multicast Feed
//
// Replicates genuine HFT network topology. Bypasses the uWebSockets TCP 
// stack and completely drops the concept of connection management to 
// blast pure binary out to the local network at sub-microsecond speeds.
//
// Zero allocations. Zero TCP ACKs. Non-blocking.
// ============================================================================

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>

#include "network/wire_protocol.hpp"

namespace optirisk::network {

class UdpPublisher {
private:
    int sock_ = -1;
    struct sockaddr_in mcast_addr_{};
    bool valid_ = false;

public:
    UdpPublisher(const char* mcast_ip = "239.255.0.1", uint16_t port = 9090) {
        sock_ = socket(AF_INET, SOCK_DGRAM, 0);
        if (sock_ < 0) {
            std::fprintf(stderr, "[warn] Failed to create UDP Multicast socket\n");
            return;
        }

        std::memset(&mcast_addr_, 0, sizeof(mcast_addr_));
        mcast_addr_.sin_family = AF_INET;
        mcast_addr_.sin_port = htons(port);
        
        if (inet_pton(AF_INET, mcast_ip, &mcast_addr_.sin_addr) <= 0) {
            std::fprintf(stderr, "[warn] Invalid UDP Multicast IP: %s\n", mcast_ip);
            close(sock_);
            sock_ = -1;
            return;
        }

        // Optimize TTL to restrict packets strictly to the local subnet (low hop limit)
        uint8_t ttl = 1;
        if (setsockopt(sock_, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof(ttl)) < 0) {
             std::fprintf(stderr, "[warn] Failed to set multicast TTL, but proceeding.\n");
        }

        // Set socket to Non-Blocking to guarantee Publisher thread never stalls
        int flags = fcntl(sock_, F_GETFL, 0);
        if (flags >= 0) {
            fcntl(sock_, F_SETFL, flags | O_NONBLOCK);
        }

        valid_ = true;
        std::printf("[udp] Mcast publisher bound to %s:%u (Non-blocking ITCH feed)\n", mcast_ip, port);
    }

    ~UdpPublisher() {
        if (sock_ >= 0) {
            close(sock_);
        }
    }

    // Explicitly delete copy semantic to prevent socket duplication
    UdpPublisher(const UdpPublisher&) = delete;
    UdpPublisher& operator=(const UdpPublisher&) = delete;

    __attribute__((always_inline))
    inline void broadcast_tick(const TickDelta& tick) noexcept {
        if (!valid_) [[unlikely]] return;

        struct { MessageHeader hdr; TickDelta payload; } __attribute__((packed)) buf;
        buf.hdr.msg_type = MsgType::TickDelta;
        buf.payload = tick;

        sendto(sock_, &buf, sizeof(buf), 0, 
              reinterpret_cast<struct sockaddr*>(&mcast_addr_), sizeof(mcast_addr_));
    }

    __attribute__((always_inline))
    inline void broadcast_var(const VaRReport& report) noexcept {
        if (!valid_) [[unlikely]] return;

        struct { MessageHeader hdr; VaRReport payload; } __attribute__((packed)) buf;
        buf.hdr.msg_type = MsgType::VaRReport;
        buf.payload = report;

        sendto(sock_, &buf, sizeof(buf), 0, 
              reinterpret_cast<struct sockaddr*>(&mcast_addr_), sizeof(mcast_addr_));
    }
};

} // namespace optirisk::network
