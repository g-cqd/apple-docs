//
//  adk_hamming.c
//  CAppleDocsKernels
//
//  Batch Hamming distance over packed sign-bit codes (`byte_width` bytes per code; 64 bytes = 512 bits
//  for `potion-retrieval-32M`).
//    - NEON (arm64): 4x16B `veorq_u8` + `vcntq_u8` + `vpaddlq_u8` + `vaddvq_u8` for 64-byte codes.
//    - AVX2 (x86-64): 2x32B `_mm256_xor_si256` + Harley-Seal / Mula `vpshufb` 4-bit nibble popcount LUT
//      + `_mm256_sad_epu8` horizontal byte sums (processes 64 bytes in two 256-bit vectors).
//    - SSE4.2 (x86-64): unrolled 64-bit hardware `_mm_popcnt_u64` (8 x `popcntq` per 64-byte row).
//    - SSE2 (x86-64): 128-bit XOR + SWAR 64-bit popcount.
//    - Scalar: portable byte-wise Kernighan / `__builtin_popcount` reference.
//

#include "CAppleDocsKernels.h"

#include <string.h>

#if defined(__x86_64__)
#include <immintrin.h>
#elif defined(__aarch64__)
#include <arm_neon.h>
#endif

static inline uint64_t adk_popcnt64_swar(uint64_t x) {
    x = x - ((x >> 1) & 0x5555555555555555ULL);
    x = (x & 0x3333333333333333ULL) + ((x >> 2) & 0x3333333333333333ULL);
    x = (x + (x >> 4)) & 0x0F0F0F0F0F0F0F0FULL;
    return (x * 0x0101010101010101ULL) >> 56;
}

void adk_hamming_batch_scalar(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances) {
    for (size_t r = 0; r < row_count; ++r) {
        const uint8_t *row = packed + r * byte_width;
        uint32_t acc = 0;
        for (size_t b = 0; b < byte_width; ++b) {
            acc += (uint32_t)__builtin_popcount((unsigned)(query[b] ^ row[b]));
        }
        out_distances[r] = (uint16_t)acc;
    }
}

#if defined(__x86_64__)
static void hamming_sse2_impl(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances) {
    for (size_t r = 0; r < row_count; ++r) {
        const uint8_t *row = packed + r * byte_width;
        uint32_t acc = 0;
        size_t b = 0;
        for (; b + 16 <= byte_width; b += 16) {
            __m128i qv = _mm_loadu_si128((const __m128i *)(const void *)(query + b));
            __m128i pv = _mm_loadu_si128((const __m128i *)(const void *)(row + b));
            __m128i xv = _mm_xor_si128(qv, pv);
            uint64_t lo = (uint64_t)_mm_cvtsi128_si64(xv);
            uint64_t hi = (uint64_t)_mm_cvtsi128_si64(_mm_srli_si128(xv, 8));
            acc += (uint32_t)(adk_popcnt64_swar(lo) + adk_popcnt64_swar(hi));
        }
        for (; b < byte_width; ++b) {
            acc += (uint32_t)__builtin_popcount((unsigned)(query[b] ^ row[b]));
        }
        out_distances[r] = (uint16_t)acc;
    }
}

__attribute__((target("sse4.2,popcnt")))
static void hamming_sse42_impl(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances) {
    if (byte_width == 64) {
        uint64_t q0, q1, q2, q3, q4, q5, q6, q7;
        memcpy(&q0, query + 0, 8);
        memcpy(&q1, query + 8, 8);
        memcpy(&q2, query + 16, 8);
        memcpy(&q3, query + 24, 8);
        memcpy(&q4, query + 32, 8);
        memcpy(&q5, query + 40, 8);
        memcpy(&q6, query + 48, 8);
        memcpy(&q7, query + 56, 8);
        for (size_t r = 0; r < row_count; ++r) {
            const uint8_t *row = packed + (r << 6);
            uint64_t p0, p1, p2, p3, p4, p5, p6, p7;
            memcpy(&p0, row + 0, 8);
            memcpy(&p1, row + 8, 8);
            memcpy(&p2, row + 16, 8);
            memcpy(&p3, row + 24, 8);
            memcpy(&p4, row + 32, 8);
            memcpy(&p5, row + 40, 8);
            memcpy(&p6, row + 48, 8);
            memcpy(&p7, row + 56, 8);
            int64_t sum = _mm_popcnt_u64(q0 ^ p0) + _mm_popcnt_u64(q1 ^ p1)
                + _mm_popcnt_u64(q2 ^ p2) + _mm_popcnt_u64(q3 ^ p3)
                + _mm_popcnt_u64(q4 ^ p4) + _mm_popcnt_u64(q5 ^ p5)
                + _mm_popcnt_u64(q6 ^ p6) + _mm_popcnt_u64(q7 ^ p7);
            out_distances[r] = (uint16_t)sum;
        }
        return;
    }
    for (size_t r = 0; r < row_count; ++r) {
        const uint8_t *row = packed + r * byte_width;
        int64_t acc = 0;
        size_t b = 0;
        for (; b + 8 <= byte_width; b += 8) {
            uint64_t qw, pw;
            memcpy(&qw, query + b, 8);
            memcpy(&pw, row + b, 8);
            acc += _mm_popcnt_u64(qw ^ pw);
        }
        for (; b < byte_width; ++b) {
            acc += __builtin_popcount((unsigned)(query[b] ^ row[b]));
        }
        out_distances[r] = (uint16_t)acc;
    }
}

__attribute__((target("avx2,popcnt")))
static inline __m256i avx2_popcnt_bytes(__m256i v, __m256i lut, __m256i low_mask) {
    __m256i lo = _mm256_and_si256(v, low_mask);
    __m256i hi = _mm256_and_si256(_mm256_srli_epi16(v, 4), low_mask);
    return _mm256_add_epi8(_mm256_shuffle_epi8(lut, lo), _mm256_shuffle_epi8(lut, hi));
}

__attribute__((target("avx2,popcnt")))
static void hamming_avx2_impl(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances) {
    const __m256i lut = _mm256_setr_epi8(
        0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4,
        0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4);
    const __m256i low_mask = _mm256_set1_epi8(0x0F);
    const __m256i zero = _mm256_setzero_si256();

    if (byte_width == 64) {
        const __m256i q0 = _mm256_loadu_si256((const __m256i *)(const void *)(query + 0));
        const __m256i q1 = _mm256_loadu_si256((const __m256i *)(const void *)(query + 32));
        for (size_t r = 0; r < row_count; ++r) {
            const uint8_t *row = packed + (r << 6);
            __m256i x0 = _mm256_xor_si256(q0, _mm256_loadu_si256((const __m256i *)(const void *)(row + 0)));
            __m256i x1 = _mm256_xor_si256(q1, _mm256_loadu_si256((const __m256i *)(const void *)(row + 32)));
            __m256i c = _mm256_add_epi8(avx2_popcnt_bytes(x0, lut, low_mask), avx2_popcnt_bytes(x1, lut, low_mask));
            __m256i sad = _mm256_sad_epu8(c, zero);
            __m128i sum128 = _mm_add_epi64(_mm256_castsi256_si128(sad), _mm256_extracti128_si256(sad, 1));
            uint64_t total = (uint64_t)_mm_cvtsi128_si64(sum128) + (uint64_t)_mm_extract_epi64(sum128, 1);
            out_distances[r] = (uint16_t)total;
        }
        return;
    }

    for (size_t r = 0; r < row_count; ++r) {
        const uint8_t *row = packed + r * byte_width;
        uint64_t total = 0;
        size_t b = 0;
        for (; b + 32 <= byte_width; b += 32) {
            __m256i qv = _mm256_loadu_si256((const __m256i *)(const void *)(query + b));
            __m256i pv = _mm256_loadu_si256((const __m256i *)(const void *)(row + b));
            __m256i sad = _mm256_sad_epu8(avx2_popcnt_bytes(_mm256_xor_si256(qv, pv), lut, low_mask), zero);
            __m128i sum128 = _mm_add_epi64(_mm256_castsi256_si128(sad), _mm256_extracti128_si256(sad, 1));
            total += (uint64_t)_mm_cvtsi128_si64(sum128) + (uint64_t)_mm_extract_epi64(sum128, 1);
        }
        for (; b < byte_width; ++b) {
            total += (uint64_t)__builtin_popcount((unsigned)(query[b] ^ row[b]));
        }
        out_distances[r] = (uint16_t)total;
    }
}
#endif  // __x86_64__

#if defined(__aarch64__)
static void hamming_neon_impl(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances) {
    if (byte_width == 64) {
        const uint8x16_t q0 = vld1q_u8(query + 0);
        const uint8x16_t q1 = vld1q_u8(query + 16);
        const uint8x16_t q2 = vld1q_u8(query + 32);
        const uint8x16_t q3 = vld1q_u8(query + 48);
        for (size_t r = 0; r < row_count; ++r) {
            const uint8_t *row = packed + (r << 6);
            uint8x16_t c0 = vcntq_u8(veorq_u8(q0, vld1q_u8(row + 0)));
            uint8x16_t c1 = vcntq_u8(veorq_u8(q1, vld1q_u8(row + 16)));
            uint8x16_t c2 = vcntq_u8(veorq_u8(q2, vld1q_u8(row + 32)));
            uint8x16_t c3 = vcntq_u8(veorq_u8(q3, vld1q_u8(row + 48)));
            // Max per-lane sum across 4x16 bytes is 4 * 8 = 32 <= 255: safe in uint8 before `vaddlvq_u8`.
            uint8x16_t s = vaddq_u8(vaddq_u8(c0, c1), vaddq_u8(c2, c3));
            out_distances[r] = vaddlvq_u8(s);
        }
        return;
    }
    if (byte_width == 32) {
        const uint8x16_t q0 = vld1q_u8(query + 0);
        const uint8x16_t q1 = vld1q_u8(query + 16);
        for (size_t r = 0; r < row_count; ++r) {
            const uint8_t *row = packed + (r << 5);
            uint8x16_t c0 = vcntq_u8(veorq_u8(q0, vld1q_u8(row + 0)));
            uint8x16_t c1 = vcntq_u8(veorq_u8(q1, vld1q_u8(row + 16)));
            out_distances[r] = vaddlvq_u8(vaddq_u8(c0, c1));
        }
        return;
    }
    for (size_t r = 0; r < row_count; ++r) {
        const uint8_t *row = packed + r * byte_width;
        uint32_t total = 0;
        size_t b = 0;
        for (; b + 16 <= byte_width; b += 16) {
            total += vaddlvq_u8(vcntq_u8(veorq_u8(vld1q_u8(query + b), vld1q_u8(row + b))));
        }
        for (; b < byte_width; ++b) {
            total += (uint32_t)__builtin_popcount((unsigned)(query[b] ^ row[b]));
        }
        out_distances[r] = (uint16_t)total;
    }
}
#endif  // __aarch64__

void adk_hamming_batch_sse2(
    const uint8_t *query, const uint8_t *packed, size_t row_count, size_t byte_width, uint16_t *out_distances) {
#if defined(__x86_64__)
    hamming_sse2_impl(query, packed, row_count, byte_width, out_distances);
#else
    adk_hamming_batch_scalar(query, packed, row_count, byte_width, out_distances);
#endif
}

void adk_hamming_batch_sse42(
    const uint8_t *query, const uint8_t *packed, size_t row_count, size_t byte_width, uint16_t *out_distances) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_SSE42) {
        hamming_sse42_impl(query, packed, row_count, byte_width, out_distances);
        return;
    }
    hamming_sse2_impl(query, packed, row_count, byte_width, out_distances);
#else
    adk_hamming_batch_scalar(query, packed, row_count, byte_width, out_distances);
#endif
}

void adk_hamming_batch_avx2(
    const uint8_t *query, const uint8_t *packed, size_t row_count, size_t byte_width, uint16_t *out_distances) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_AVX2) {
        hamming_avx2_impl(query, packed, row_count, byte_width, out_distances);
        return;
    }
    adk_hamming_batch_sse42(query, packed, row_count, byte_width, out_distances);
#else
    adk_hamming_batch_scalar(query, packed, row_count, byte_width, out_distances);
#endif
}

void adk_hamming_batch_neon(
    const uint8_t *query, const uint8_t *packed, size_t row_count, size_t byte_width, uint16_t *out_distances) {
#if defined(__aarch64__)
    hamming_neon_impl(query, packed, row_count, byte_width, out_distances);
#else
    adk_hamming_batch_scalar(query, packed, row_count, byte_width, out_distances);
#endif
}

void adk_hamming_batch(
    const uint8_t *query, const uint8_t *packed, size_t row_count, size_t byte_width, uint16_t *out_distances) {
    switch (adk_isa()) {
#if defined(__x86_64__)
        case ADK_ISA_X86_AVX2:
            hamming_avx2_impl(query, packed, row_count, byte_width, out_distances);
            return;
        case ADK_ISA_X86_SSE42:
            hamming_sse42_impl(query, packed, row_count, byte_width, out_distances);
            return;
        case ADK_ISA_X86_SSE2:
            hamming_sse2_impl(query, packed, row_count, byte_width, out_distances);
            return;
#elif defined(__aarch64__)
        case ADK_ISA_ARM_NEON:
            hamming_neon_impl(query, packed, row_count, byte_width, out_distances);
            return;
#endif
        default:
            adk_hamming_batch_scalar(query, packed, row_count, byte_width, out_distances);
            return;
    }
}
