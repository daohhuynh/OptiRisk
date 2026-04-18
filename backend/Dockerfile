# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM ubuntu:24.04 AS builder

# Avoid interactive prompts during apt install
ENV DEBIAN_FRONTEND=noninteractive

# Install C++23 toolchain and dependencies
RUN apt-get update && apt-get install -y \
    clang \
    cmake \
    make \
    libz-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy backend source and vendored libraries
COPY backend/ ./backend/
# Copy critical data binary from root for the build/test environment
COPY optirisk_memory.bin ./optirisk_memory.bin

# Step 1: Rebuild uSockets for the target Linux architecture (AVX2 optimized)
WORKDIR /app/backend/vendor/uWebSockets/uSockets
RUN make clean && make -j$(nproc) WITH_OPENSSL=0

# Step 2: Build the OptiRisk engine
WORKDIR /app/backend/build
RUN cmake .. -DCMAKE_BUILD_TYPE=Release \
             -DCMAKE_CXX_COMPILER=clang++ \
             -DCMAKE_CXX_FLAGS="-O3 -mavx2 -pthread -DNDEBUG"
RUN make -j$(nproc)

# ── Stage 2: Runtime ─────────────────────────────────────────────────────────
FROM ubuntu:24.04

# Only install runtime shared libraries to keep the image lean
RUN apt-get update && apt-get install -y \
    libz1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the compiled executable
COPY --from=builder /app/backend/build/optirisk /app/bin/optirisk
# Copy the pre-generated risk network database
COPY --from=builder /app/optirisk_memory.bin /app/optirisk_memory.bin

# Open the primary WebSocket ingress port
EXPOSE 8080

# Set CWD to /app/bin so binary finds ../optirisk_memory.bin flawlessly
WORKDIR /app/bin

# Use EXEC form for ENTRYPOINT to ensure the process receives SIGINT/SIGTERM 
# directly from the Docker daemon (No shell wrapping).
ENTRYPOINT ["./optirisk"]
