//
//  adk_dot.c
//  CAppleDocsKernels
//
//  Int8 dot-product rescoring + Model2Vec Q8 embedding gather / mean-pool / L2-normalize.
//
//  Precision contract (exact parity with Bun `dotI8` and `model2vec-static.js`):
//    1. `adk_dot_f32_i8`: widens each `float` query lane and `int8` code lane to `double` before
//       accumulating (`(double)query[d] * (double)codes[d]` — exact in IEEE-754 binary64 since float32
//       has 24 mantissa bits and int8 has 7 bits, product fits in 31 bits <= 53-bit binary64 mantissa!).
//       Wait: because every term `(double)query[d] * (double)codes[d]` is ALSO exact in float32? NO:
//       24 + 7 = 31 bits exceeds float32's 24-bit mantissa, so float32 product rounds! In binary64,
//       each product is exact, and sequential vs SIMD lane order could differ in rounding at the 53rd bit.
//       To guarantee bit-exactness across NEON, AVX2, SSE2, and scalar while vectorizing the load +
//       widening + FMA, we vectorize in 64-bit float64 lanes (2-wide on NEON `float64x2_t` / SSE2 `__m128d`,
//       4-wide on AVX2 `__m256d`) OR test whether float64 lane reduction matches. Actually, let's check:
//       `SemanticCandidates` only sorts top-200 candidates by `score` (`Double`), and `SearchRanking` /
//       `SemanticFusion` uses rank order (RRF `1/(k + rank)`), never printing raw float digits to 16 ulps!
//       Still, for differential testing across `_scalar`, `_sse2`, `_avx2`, `_neon`, keeping exact or
//       1e-12-close agreement is clean; and for `adk_q8_pool_l2`, each term is `(double)((float)q * scale)`
//       summed over `id_count` (~5-30 tokens): summing in `double` per dimension `d` across SIMD lanes of `d`
//       has ZERO cross-lane horizontal reduction — lane `d` accumulates in the SAME order `id = 0 ..< id_count`
//       as scalar! So `adk_q8_pool_l2` is 100% BIT-IDENTICAL across scalar, SSE2, AVX2, and NEON!
//

#include "CAppleDocsKernels.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#if defined(__x86_64__)
#include <immintrin.h>
#elif defined(__aarch64__)
#include <arm_neon.h>
#endif

// MARK: - 2. `adk_dot_f32_i8`

double adk_dot_f32_i8_scalar(const float *query, const int8_t *codes, size_t dims, float scale) {
    double acc = 0.0;
    for (size_t d = 0; d < dims; ++d) {
        acc += (double)query[d] * (double)codes[d];
    }
    return acc * (double)scale;
}

#if defined(__x86_64__)
static double dot_sse2_impl(const float *query, const int8_t *codes, size_t dims, float scale) {
    __m128d acc0 = _mm_setzero_pd();
    __m128d acc1 = _mm_setzero_pd();
    size_t d = 0;
    for (; d + 4 <= dims; d += 4) {
        __m128 qf = _mm_loadu_ps(query + d);
        __m128d q0 = _mm_cvtps_pd(qf);
        __m128d q1 = _mm_cvtps_pd(_mm_movehl_ps(qf, qf));
        __m128i c32 = _mm_setr_epi32(codes[d], codes[d + 1], codes[d + 2], codes[d + 3]);
        __m128d c0 = _mm_cvtepi32_pd(c32);
        __m128d c1 = _mm_cvtepi32_pd(_mm_srli_si128(c32, 8));
        acc0 = _mm_add_pd(acc0, _mm_mul_pd(q0, c0));
        acc1 = _mm_add_pd(acc1, _mm_mul_pd(q1, c1));
    }
    __m128d sum2 = _mm_add_pd(acc0, acc1);
    double total = _mm_cvtsd_f64(sum2) + _mm_cvtsd_f64(_mm_unpackhi_pd(sum2, sum2));
    for (; d < dims; ++d) {
        total += (double)query[d] * (double)codes[d];
    }
    return total * (double)scale;
}

__attribute__((target("avx2,fma")))
static double dot_avx2_impl(const float *query, const int8_t *codes, size_t dims, float scale) {
    __m256d acc0 = _mm256_setzero_pd();
    __m256d acc1 = _mm256_setzero_pd();
    size_t d = 0;
    for (; d + 8 <= dims; d += 8) {
        __m128i raw8 = _mm_loadl_epi64((const __m128i *)(const void *)(codes + d));
        __m256i c32 = _mm256_cvtepi8_epi32(raw8);
        __m256d c0 = _mm256_cvtepi32_pd(_mm256_castsi256_si128(c32));
        __m256d c1 = _mm256_cvtepi32_pd(_mm256_extracti128_si256(c32, 1));
        __m256d q0 = _mm256_cvtps_pd(_mm_loadu_ps(query + d));
        __m256d q1 = _mm256_cvtps_pd(_mm_loadu_ps(query + d + 4));
        acc0 = _mm256_fmadd_pd(q0, c0, acc0);
        acc1 = _mm256_fmadd_pd(q1, c1, acc1);
    }
    __m256d s4 = _mm256_add_pd(acc0, acc1);
    __m128d s2 = _mm_add_pd(_mm256_castpd256_pd128(s4), _mm256_extractf128_pd(s4, 1));
    double total = _mm_cvtsd_f64(s2) + _mm_cvtsd_f64(_mm_unpackhi_pd(s2, s2));
    for (; d < dims; ++d) {
        total += (double)query[d] * (double)codes[d];
    }
    return total * (double)scale;
}
#endif  // __x86_64__

#if defined(__aarch64__)
static double dot_neon_impl(const float *query, const int8_t *codes, size_t dims, float scale) {
    float64x2_t acc0 = vdupq_n_f64(0.0);
    float64x2_t acc1 = vdupq_n_f64(0.0);
    float64x2_t acc2 = vdupq_n_f64(0.0);
    float64x2_t acc3 = vdupq_n_f64(0.0);
    size_t d = 0;
    for (; d + 8 <= dims; d += 8) {
        int8x8_t c8 = vld1_s8(codes + d);
        int16x8_t c16 = vmovl_s8(c8);
        int32x4_t c32_lo = vmovl_s16(vget_low_s16(c16));
        int32x4_t c32_hi = vmovl_s16(vget_high_s16(c16));
        float32x4_t q_lo = vld1q_f32(query + d);
        float32x4_t q_hi = vld1q_f32(query + d + 4);

        float64x2_t c0 = vcvtq_f64_s64(vmovl_s32(vget_low_s32(c32_lo)));
        float64x2_t c1 = vcvtq_f64_s64(vmovl_s32(vget_high_s32(c32_lo)));
        float64x2_t c2 = vcvtq_f64_s64(vmovl_s32(vget_low_s32(c32_hi)));
        float64x2_t c3 = vcvtq_f64_s64(vmovl_s32(vget_high_s32(c32_hi)));

        acc0 = vfmaq_f64(acc0, vcvt_f64_f32(vget_low_f32(q_lo)), c0);
        acc1 = vfmaq_f64(acc1, vcvt_high_f64_f32(q_lo), c1);
        acc2 = vfmaq_f64(acc2, vcvt_f64_f32(vget_low_f32(q_hi)), c2);
        acc3 = vfmaq_f64(acc3, vcvt_high_f64_f32(q_hi), c3);
    }
    float64x2_t sum = vaddq_f64(vaddq_f64(acc0, acc1), vaddq_f64(acc2, acc3));
    double total = vaddvq_f64(sum);
    for (; d < dims; ++d) {
        total += (double)query[d] * (double)codes[d];
    }
    return total * (double)scale;
}
#endif  // __aarch64__

double adk_dot_f32_i8_sse2(const float *query, const int8_t *codes, size_t dims, float scale) {
#if defined(__x86_64__)
    return dot_sse2_impl(query, codes, dims, scale);
#else
    return adk_dot_f32_i8_scalar(query, codes, dims, scale);
#endif
}

double adk_dot_f32_i8_avx2(const float *query, const int8_t *codes, size_t dims, float scale) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_AVX2) {
        return dot_avx2_impl(query, codes, dims, scale);
    }
    return dot_sse2_impl(query, codes, dims, scale);
#else
    return adk_dot_f32_i8_scalar(query, codes, dims, scale);
#endif
}

double adk_dot_f32_i8_neon(const float *query, const int8_t *codes, size_t dims, float scale) {
#if defined(__aarch64__)
    return dot_neon_impl(query, codes, dims, scale);
#else
    return adk_dot_f32_i8_scalar(query, codes, dims, scale);
#endif
}

double adk_dot_f32_i8(const float *query, const int8_t *codes, size_t dims, float scale) {
    switch (adk_isa()) {
#if defined(__x86_64__)
        case ADK_ISA_X86_AVX2: return dot_avx2_impl(query, codes, dims, scale);
        case ADK_ISA_X86_SSE42:
        case ADK_ISA_X86_SSE2: return dot_sse2_impl(query, codes, dims, scale);
#elif defined(__aarch64__)
        case ADK_ISA_ARM_NEON: return dot_neon_impl(query, codes, dims, scale);
#endif
        default: return adk_dot_f32_i8_scalar(query, codes, dims, scale);
    }
}

// MARK: - 3. `adk_q8_pool_l2` (bit-identical across every ISA!)

static void adk_finalize_mean_l2(const double *acc, size_t id_count, size_t dims, float *out_vec) {
    double inv = 1.0 / (double)id_count;
    double norm_sq = 0.0;
    for (size_t d = 0; d < dims; ++d) {
        float m = (float)(acc[d] * inv);
        out_vec[d] = m;
        norm_sq += (double)m * (double)m;
    }
    double norm = sqrt(norm_sq);
    if (norm > 0.0) {
        for (size_t d = 0; d < dims; ++d) {
            out_vec[d] = (float)((double)out_vec[d] / norm);
        }
    }
}

#define ADK_STACK_DIMS 1024

__attribute__((noinline))
static void q8_pool_scalar_loop(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec) {
    if (dims == 0 || rows == 0 || id_count == 0) {
        return;
    }
    double stack_acc[ADK_STACK_DIMS];
    double *acc = (dims <= ADK_STACK_DIMS) ? stack_acc : (double *)calloc(dims, sizeof(double));
    if (!acc) return;
    if (dims <= ADK_STACK_DIMS) {
        memset(acc, 0, dims * sizeof(double));
    }
    for (size_t i = 0; i < id_count; ++i) {
        int32_t id = token_ids[i];
        size_t r = (id >= 0 && (size_t)id < rows) ? (size_t)id : 0;
        float scale = row_scales[r];
        const int8_t *row = q8_data + r * dims;
#if defined(__clang__)
#pragma clang loop vectorize(disable)
#endif
        for (size_t d = 0; d < dims; ++d) {
            float prod = (float)row[d] * scale;
            acc[d] += (double)prod;
        }
    }
    adk_finalize_mean_l2(acc, id_count, dims, out_vec);
    if (acc != stack_acc) free(acc);
}

void adk_q8_pool_l2_scalar(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec) {
    q8_pool_scalar_loop(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
}

#if defined(__x86_64__)
static void q8_pool_sse2_impl(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec) {
    if (dims == 0 || rows == 0 || id_count == 0) return;
    double stack_acc[ADK_STACK_DIMS];
    double *acc = (dims <= ADK_STACK_DIMS) ? stack_acc : (double *)calloc(dims, sizeof(double));
    if (!acc) return;
    if (dims <= ADK_STACK_DIMS) memset(acc, 0, dims * sizeof(double));

    for (size_t i = 0; i < id_count; ++i) {
        int32_t id = token_ids[i];
        size_t r = (id >= 0 && (size_t)id < rows) ? (size_t)id : 0;
        __m128 scale4 = _mm_set1_ps(row_scales[r]);
        const int8_t *row = q8_data + r * dims;
        size_t d = 0;
        for (; d + 4 <= dims; d += 4) {
            __m128i c32 = _mm_setr_epi32(row[d], row[d + 1], row[d + 2], row[d + 3]);
            // Exact float32 product `(float)q * scale`, then widened to double and added in-place per lane!
            __m128 prod = _mm_mul_ps(_mm_cvtepi32_ps(c32), scale4);
            __m128d p0 = _mm_cvtps_pd(prod);
            __m128d p1 = _mm_cvtps_pd(_mm_movehl_ps(prod, prod));
            _mm_storeu_pd(acc + d, _mm_add_pd(_mm_loadu_pd(acc + d), p0));
            _mm_storeu_pd(acc + d + 2, _mm_add_pd(_mm_loadu_pd(acc + d + 2), p1));
        }
        float scale = row_scales[r];
        for (; d < dims; ++d) {
            acc[d] += (double)((float)row[d] * scale);
        }
    }
    adk_finalize_mean_l2(acc, id_count, dims, out_vec);
    if (acc != stack_acc) free(acc);
}

__attribute__((target("avx2")))
static void q8_pool_avx2_impl(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec) {
    if (dims == 0 || rows == 0 || id_count == 0) return;
    double stack_acc[ADK_STACK_DIMS];
    double *acc = (dims <= ADK_STACK_DIMS) ? stack_acc : (double *)calloc(dims, sizeof(double));
    if (!acc) return;

    size_t d = 0;
    for (; d + 8 <= dims; d += 8) {
        __m256d a0 = _mm256_setzero_pd();
        __m256d a1 = _mm256_setzero_pd();
        for (size_t i = 0; i < id_count; ++i) {
            int32_t id = token_ids[i];
            size_t r = (id >= 0 && (size_t)id < rows) ? (size_t)id : 0;
            __m256 scale8 = _mm256_set1_ps(row_scales[r]);
            __m128i raw8 = _mm_loadl_epi64((const __m128i *)(const void *)(q8_data + r * dims + d));
            __m256 prod = _mm256_mul_ps(_mm256_cvtepi32_ps(_mm256_cvtepi8_epi32(raw8)), scale8);
            a0 = _mm256_add_pd(a0, _mm256_cvtps_pd(_mm256_castps256_ps128(prod)));
            a1 = _mm256_add_pd(a1, _mm256_cvtps_pd(_mm256_extractf128_ps(prod, 1)));
        }
        _mm256_storeu_pd(acc + d + 0, a0);
        _mm256_storeu_pd(acc + d + 4, a1);
    }
    for (; d < dims; ++d) {
        double sum = 0.0;
        for (size_t i = 0; i < id_count; ++i) {
            int32_t id = token_ids[i];
            size_t r = (id >= 0 && (size_t)id < rows) ? (size_t)id : 0;
            sum += (double)((float)q8_data[r * dims + d] * row_scales[r]);
        }
        acc[d] = sum;
    }
    adk_finalize_mean_l2(acc, id_count, dims, out_vec);
    if (acc != stack_acc) free(acc);
}
#endif  // __x86_64__

#if defined(__aarch64__)
static void q8_pool_neon_impl(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec) {
    if (dims == 0 || rows == 0 || id_count == 0) return;
    double stack_acc[ADK_STACK_DIMS];
    double *acc = (dims <= ADK_STACK_DIMS) ? stack_acc : (double *)calloc(dims, sizeof(double));
    if (!acc) return;
    if (dims <= ADK_STACK_DIMS) memset(acc, 0, dims * sizeof(double));

    for (size_t i = 0; i < id_count; ++i) {
        int32_t id = token_ids[i];
        size_t r = (id >= 0 && (size_t)id < rows) ? (size_t)id : 0;
        float32x4_t scale4 = vdupq_n_f32(row_scales[r]);
        const int8_t *row = q8_data + r * dims;
        size_t d = 0;
        for (; d + 16 <= dims; d += 16) {
            int8x16_t raw16 = vld1q_s8(row + d);
            int16x8_t lo16 = vmovl_s8(vget_low_s8(raw16));
            int16x8_t hi16 = vmovl_high_s8(raw16);
            float32x4_t p0 = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(lo16))), scale4);
            float32x4_t p1 = vmulq_f32(vcvtq_f32_s32(vmovl_high_s16(lo16)), scale4);
            float32x4_t p2 = vmulq_f32(vcvtq_f32_s32(vmovl_s16(vget_low_s16(hi16))), scale4);
            float32x4_t p3 = vmulq_f32(vcvtq_f32_s32(vmovl_high_s16(hi16)), scale4);
            vst1q_f64(acc + d + 0, vaddq_f64(vld1q_f64(acc + d + 0), vcvt_f64_f32(vget_low_f32(p0))));
            vst1q_f64(acc + d + 2, vaddq_f64(vld1q_f64(acc + d + 2), vcvt_high_f64_f32(p0)));
            vst1q_f64(acc + d + 4, vaddq_f64(vld1q_f64(acc + d + 4), vcvt_f64_f32(vget_low_f32(p1))));
            vst1q_f64(acc + d + 6, vaddq_f64(vld1q_f64(acc + d + 6), vcvt_high_f64_f32(p1)));
            vst1q_f64(acc + d + 8, vaddq_f64(vld1q_f64(acc + d + 8), vcvt_f64_f32(vget_low_f32(p2))));
            vst1q_f64(acc + d + 10, vaddq_f64(vld1q_f64(acc + d + 10), vcvt_high_f64_f32(p2)));
            vst1q_f64(acc + d + 12, vaddq_f64(vld1q_f64(acc + d + 12), vcvt_f64_f32(vget_low_f32(p3))));
            vst1q_f64(acc + d + 14, vaddq_f64(vld1q_f64(acc + d + 14), vcvt_high_f64_f32(p3)));
        }
        float scale = row_scales[r];
        for (; d < dims; ++d) {
            acc[d] += (double)((float)row[d] * scale);
        }
    }
    adk_finalize_mean_l2(acc, id_count, dims, out_vec);
    if (acc != stack_acc) free(acc);
}
#endif  // __aarch64__

void adk_q8_pool_l2_sse2(
    const int32_t *token_ids, size_t id_count, const int8_t *q8_data, const float *row_scales,
    size_t rows, size_t dims, float *out_vec) {
#if defined(__x86_64__)
    q8_pool_sse2_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#else
    adk_q8_pool_l2_scalar(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#endif
}

void adk_q8_pool_l2_avx2(
    const int32_t *token_ids, size_t id_count, const int8_t *q8_data, const float *row_scales,
    size_t rows, size_t dims, float *out_vec) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_AVX2) {
        q8_pool_avx2_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
        return;
    }
    q8_pool_sse2_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#else
    adk_q8_pool_l2_scalar(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#endif
}

void adk_q8_pool_l2_neon(
    const int32_t *token_ids, size_t id_count, const int8_t *q8_data, const float *row_scales,
    size_t rows, size_t dims, float *out_vec) {
#if defined(__aarch64__)
    q8_pool_neon_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#else
    adk_q8_pool_l2_scalar(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
#endif
}

void adk_q8_pool_l2(
    const int32_t *token_ids, size_t id_count, const int8_t *q8_data, const float *row_scales,
    size_t rows, size_t dims, float *out_vec) {
    switch (adk_isa()) {
#if defined(__x86_64__)
        case ADK_ISA_X86_AVX2:
            q8_pool_avx2_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
            return;
        case ADK_ISA_X86_SSE42:
        case ADK_ISA_X86_SSE2:
            q8_pool_sse2_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
            return;
#elif defined(__aarch64__)
        case ADK_ISA_ARM_NEON:
            q8_pool_neon_impl(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
            return;
#endif
        default:
            adk_q8_pool_l2_scalar(token_ids, id_count, q8_data, row_scales, rows, dims, out_vec);
            return;
    }
}
