cmake_minimum_required(VERSION 3.25)
project(optirisk LANGUAGES CXX)

# ── C++23 Standard ──────────────────────────────────────────────────
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ── Maximum Performance Flags ───────────────────────────────────────
set(CMAKE_CXX_FLAGS_RELEASE "-O3 -march=native -mavx2 -mfma -Wall -Wextra -Werror -DNDEBUG")
set(CMAKE_CXX_FLAGS_DEBUG   "-O0 -g -fsanitize=address,undefined -Wall -Wextra -Werror")

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ── Sources ─────────────────────────────────────────────────────────
add_executable(optirisk
    src/main.cpp
)

target_include_directories(optirisk PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# ── Threading ───────────────────────────────────────────────────────
find_package(Threads REQUIRED)
target_link_libraries(optirisk PRIVATE Threads::Threads)

# ── Compile Commands (for IDE integration) ──────────────────────────
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
