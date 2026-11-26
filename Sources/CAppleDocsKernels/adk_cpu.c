//
//  adk_cpu.c
//  CAppleDocsKernels
//
//  Thread-safe one-time runtime ISA detection (`pthread_once`), matching `CAemiCPU` / `CAemiKernels`:
//  arm64 baseline NEON; x86-64 CPUID via `__builtin_cpu_init` + `__builtin_cpu_supports` (SSE2 -> SSE4.2+POPCNT
//  -> AVX2+FMA+BMI2). Under Rosetta 2, `__builtin_cpu_supports` reports AVX2 only when Rosetta advertises it.
//

#include "CAppleDocsKernels.h"

#include <pthread.h>

static int g_isa = ADK_ISA_SCALAR;
static pthread_once_t g_once = PTHREAD_ONCE_INIT;

static void adk_resolve_isa(void) {
#if defined(__aarch64__)
    g_isa = ADK_ISA_ARM_NEON;
#elif defined(__x86_64__)
    __builtin_cpu_init();
    if (__builtin_cpu_supports("avx2") && __builtin_cpu_supports("fma") && __builtin_cpu_supports("popcnt")) {
        g_isa = ADK_ISA_X86_AVX2;
    } else if (__builtin_cpu_supports("sse4.2") && __builtin_cpu_supports("ssse3") && __builtin_cpu_supports("popcnt")) {
        g_isa = ADK_ISA_X86_SSE42;
    } else {
        g_isa = ADK_ISA_X86_SSE2;
    }
#else
    g_isa = ADK_ISA_SCALAR;
#endif
}

int adk_isa(void) {
    pthread_once(&g_once, adk_resolve_isa);
    return g_isa;
}

const char *adk_backend(void) {
    switch (adk_isa()) {
        case ADK_ISA_ARM_NEON: return "neon";
        case ADK_ISA_X86_AVX2: return "avx2";
        case ADK_ISA_X86_SSE42: return "sse4.2";
        case ADK_ISA_X86_SSE2: return "sse2";
        default: return "scalar";
    }
}
