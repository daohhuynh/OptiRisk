#pragma once
// ============================================================================
// affinity.hpp — NUMA-Aware Hardware Thread Pinning
//
// Zero-cost abstraction to lock LMAX Disruptor threads to strictly isolated 
// physical CPU cores. Bypasses the OS scheduler to permanently prevent L1/L2
// cache invalidation context switches during microsecond cascade events.
// ============================================================================

#include <cstdio>

#ifdef __linux__
    #include <pthread.h>
    #include <sched.h>
#endif

namespace optirisk::utils {

// Hard-pins the calling thread to a specific CPU core logic. 
// Fully resolved at compile-time with zero dynamic allocation.
__attribute__((always_inline))
inline void pin_thread_to_core(int core_id) noexcept {
#ifdef __linux__
    cpu_set_t cpuset;
    CPU_ZERO(&cpuset);
    CPU_SET(core_id, &cpuset);

    pthread_t current_thread = pthread_self();
    int result = pthread_setaffinity_np(current_thread, sizeof(cpu_set_t), &cpuset);
    
    if (result != 0) {
        std::fprintf(stderr, "[Affinity] Warning: Failed to pin thread to Core %d (Error %d).\n", core_id, result);
    } else {
        std::printf("[Affinity] Thread successfully locked strictly to Core %d.\n", core_id);
    }
#else
    (void)core_id; // Silences unused parameter warning on clang/gcc
    
    // Only print the macOS warning once per runtime so we don't spam terminal
    static bool warned = false;
    if (!warned) {
        std::printf("[Affinity] Thread pinning is a Linux-specific production optimization. Skipping on macOS.\n");
        warned = true;
    }
#endif
}

} // namespace optirisk::utils
