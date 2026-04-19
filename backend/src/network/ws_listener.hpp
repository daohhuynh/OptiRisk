#pragma once
// ============================================================================
// ws_listener.hpp — Single-Threaded Binary WebSocket Listener
//
// Lightweight WebSocket server built on uWebSockets (which uses uSockets/kqueue
// on macOS, epoll on Linux). Single-threaded event loop — no mutexes, no
// dynamic allocation on the message path.
//
// Usage:
//   Runs on Thread 3 (Publisher) of the Disruptor pipeline. Receives
//   ShockPayload from the frontend, publishes TickDelta to all subscribers.
//
// Architecture:
//   - Single us_listen_socket_t bound to a port
//   - Each connected client is a uWS::WebSocket<false, true, PerSocketData>
//   - Incoming binary frames are parsed via memcpy into ShockPayload
//   - Outgoing binary frames are pre-serialized TickDelta/NodeSnapshot
//   - The event loop is driven by uWS::App::run() (non-blocking for our
//     purposes — we tick it manually in integration with the Disruptor)
// ============================================================================

#include <cstdio>
#include <cstring>
#include <cstdint>
#include <functional>

// uWebSockets header — pulls in the full single-header amalgam
// Suppress C++23 deprecation of std::aligned_storage_t in their MoveOnlyFunction.h
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#include <App.h>
#pragma GCC diagnostic pop

#include "wire_protocol.hpp"

namespace optirisk::network {

// ── Per-Socket User Data ──────────────────────────────────────────
// Attached to each WebSocket connection. No heap allocation.
struct PerSocketData {
    uint32_t client_id;    // Monotonic connection counter
    uint64_t msgs_recv;    // Inbound message counter (diagnostics)
    uint64_t msgs_sent;    // Outbound message counter (diagnostics)
};

// ── Callback Type for Received Shocks ─────────────────────────────
// The listener doesn't own the simulation logic. It forwards parsed
// ShockPayloads to the caller via this callback, which is set once
// at construction and never changes (no dynamic dispatch).
using ShockCallback = std::function<void(const ShockPayload&)>;

// ── WebSocket Listener ────────────────────────────────────────────
//
// Non-owning, non-copyable. The caller constructs this on the stack
// in the publisher thread and calls run(). It blocks on the event
// loop until shutdown() is called from another thread.
//
class WsListener {
public:
    WsListener(int port, ShockCallback on_shock)
        : port_(port)
        , on_shock_(std::move(on_shock))
    {}

    // Non-copyable, non-movable (captures `this` in lambdas)
    WsListener(const WsListener&)            = delete;
    WsListener& operator=(const WsListener&) = delete;
    WsListener(WsListener&&)                 = delete;
    WsListener& operator=(WsListener&&)      = delete;

    // ── Start the event loop (blocking) ───────────────────────────
    void run() {
        auto app = uWS::App();

        app.ws<PerSocketData>("/*", {
            // ── Connection Settings ───────────────────────────────
            .compression     = uWS::DISABLED,         // No per-message deflate — pure binary
            .maxPayloadLength = 256,                   // ShockPayload is 56 bytes; leave headroom
            .idleTimeout      = 120,                   // 2 min keepalive
            .maxBackpressure  = 1024 * 1024,           // 1 MB backpressure limit

            // ── Open Handler ──────────────────────────────────────
            .open = [this](auto* ws) {
                auto* data = ws->getUserData();
                data->client_id = next_client_id_++;
                data->msgs_recv = 0;
                data->msgs_sent = 0;
                ++active_connections_;

                std::printf("[ws] client %u connected | active=%u\n",
                            data->client_id, active_connections_);

                // Subscribe to the broadcast topic
                ws->subscribe("tick");
            },

            // ── Message Handler (binary ShockPayload) ─────────────
            .message = [this](auto* ws, std::string_view message, uWS::OpCode opCode) {
                if (opCode != uWS::BINARY) [[unlikely]] {
                    std::printf("[ws] WARNING: non-binary message rejected (opcode=%d)\n",
                                static_cast<int>(opCode));
                    return;
                }

                auto* data = ws->getUserData();
                ++data->msgs_recv;

                // Validate minimum size: MessageHeader + ShockPayload
                const auto* raw = reinterpret_cast<const uint8_t*>(message.data());
                const std::size_t len = message.size();

                // ── Parse with or without MessageHeader prefix ────
                // Accept both raw ShockPayload (56 bytes) and
                // header-prefixed (60 bytes) for flexibility.
                ShockPayload shock{};

                if (len == sizeof(ShockPayload)) [[likely]] {
                    // Raw payload — no header
                    std::memcpy(&shock, raw, sizeof(ShockPayload));
                } else if (len >= sizeof(MessageHeader) + sizeof(ShockPayload)) {
                    // Header-prefixed
                    MessageHeader hdr{};
                    std::memcpy(&hdr, raw, sizeof(MessageHeader));

                    if (hdr.msg_type != MsgType::ShockPayload) [[unlikely]] {
                        std::printf("[ws] ERROR: unexpected msg_type=0x%02X from client %u\n",
                                    static_cast<unsigned>(hdr.msg_type), data->client_id);
                        return;
                    }

                    std::memcpy(&shock, raw + sizeof(MessageHeader), sizeof(ShockPayload));
                } else [[unlikely]] {
                    std::printf("[ws] ERROR: payload too small (%zu bytes, need %zu) from client %u\n",
                                len, sizeof(ShockPayload), data->client_id);
                    return;
                }

                // ── Log received shock ────────────────────────────
                std::printf("[ws] SHOCK from client %u | node=%u type=%u "
                            "eq=%.4f re=%.4f cr=%.4f tr=%.4f cb=%.4f\n",
                            data->client_id,
                            shock.target_node_id,
                            shock.shock_type,
                            shock.equities_delta,
                            shock.real_estate_delta,
                            shock.crypto_delta,
                            shock.treasuries_delta,
                            shock.corp_bonds_delta);

                // ── Forward to compute pipeline ───────────────────
                if (on_shock_) {
                    on_shock_(shock);
                }
            },

            // ── Close Handler ─────────────────────────────────────
            .close = [this](auto* ws, int code, std::string_view /*reason*/) {
                auto* data = ws->getUserData();
                --active_connections_;

                std::printf("[ws] client %u disconnected (code=%d) | recv=%llu sent=%llu | active=%u\n",
                            data->client_id, code,
                            static_cast<unsigned long long>(data->msgs_recv),
                            static_cast<unsigned long long>(data->msgs_sent),
                            active_connections_);
            }
        })

        .listen(port_, [this](auto* listen_socket) {
            if (listen_socket) {
                listen_socket_ = listen_socket;
                std::printf("[ws] listening on port %d\n", port_);
            } else {
                std::printf("[ws] ERROR: failed to listen on port %d\n", port_);
            }
        });

        // Capture the loop pointer so other threads can defer publishes onto
        // it. uWS::App::publish() is NOT thread-safe — it must be invoked
        // from the loop thread or it will silently corrupt the per-socket
        // backpressure buffers and tear down connections at random.
        loop_ = uWS::Loop::get();
        app_  = &app;
        app.run();
        app_  = nullptr;
        loop_ = nullptr;
    }

    // ── Broadcast a TickDelta to all connected clients ────────────
    // Called from the publisher thread. We serialize into a small heap
    // buffer (60 bytes) and defer the actual publish onto the uWS event
    // loop — uWS internals are single-threaded.
    void broadcast_tick(const TickDelta& tick) {
        if (!loop_ || !app_) [[unlikely]] return;

        constexpr std::size_t TOTAL = sizeof(MessageHeader) + sizeof(TickDelta);
        auto* bytes = new uint8_t[TOTAL];
        const std::size_t n = serialize_tick(tick, bytes, TOTAL);
        if (n == 0) { delete[] bytes; return; }

        loop_->defer([this, bytes, n]() {
            if (app_) {
                app_->publish("tick",
                             std::string_view(reinterpret_cast<const char*>(bytes), n),
                             uWS::BINARY);
            }
            delete[] bytes;
        });
    }

    // ── Broadcast a VaRReport to all connected clients ────────────
    void broadcast_var(const VaRReport& report) {
        if (!loop_ || !app_) [[unlikely]] return;

        constexpr std::size_t TOTAL = sizeof(MessageHeader) + sizeof(VaRReport);
        auto* bytes = new uint8_t[TOTAL];

        MessageHeader hdr{};
        hdr.msg_type    = MsgType::VaRReport;
        hdr.payload_len = sizeof(VaRReport);
        std::memcpy(bytes, &hdr, sizeof(MessageHeader));
        std::memcpy(bytes + sizeof(MessageHeader), &report, sizeof(VaRReport));

        loop_->defer([this, bytes]() {
            if (app_) {
                app_->publish("tick",
                             std::string_view(reinterpret_cast<const char*>(bytes), TOTAL),
                             uWS::BINARY);
            }
            delete[] bytes;
        });
    }

    // ── Graceful shutdown (called from signal handler thread) ─────
    void shutdown() {
        if (listen_socket_) {
            us_listen_socket_close(0, listen_socket_);
            listen_socket_ = nullptr;
        }
    }

    [[nodiscard]] uint32_t active_connections() const noexcept {
        return active_connections_;
    }

private:
    int              port_;
    ShockCallback    on_shock_;
    us_listen_socket_t* listen_socket_ = nullptr;
    uWS::App*        app_             = nullptr;
    uWS::Loop*       loop_            = nullptr; // owned by the network thread
    uint32_t         next_client_id_  = 0;
    uint32_t         active_connections_ = 0;
};

} // namespace optirisk::network
