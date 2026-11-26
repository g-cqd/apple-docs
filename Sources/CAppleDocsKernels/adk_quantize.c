//
//  adk_quantize.c
//  CAppleDocsKernels
//
//  Sign-bit packing (`adk_quantize_sign_bits`) + symmetric int8 quantization (`adk_quantize_i8`),
//  matching Bun's `quantizeTo` and `quantizeI8` bit-for-bit across scalar, SSE2, AVX2, and NEON.
//

#include "CAppleDocsKernels.h"

#include <math.h>
#include <string.h>

#if defined(__x86_64__)
#include <immintrin.h>
#elif defined(__aarch64__)
#include <arm_neon.h>
#endif

// MARK: - 4a. `adk_quantize_sign_bits` (bit `(i & 7)` of byte `(i >> 3)` is 1 iff `vec[i] >= 0.0f`)

void adk_quantize_sign_bits_scalar(const float *vec, size_t dims, uint8_t *out_bits) {
    size_t byte_len = (dims + 7) >> 3;
    memset(out_bits, 0, byte_len);
    for (size_t i = 0; i < dims; ++i) {
        if (vec[i] >= 0.0f) {
            out_bits[i >> 3] |= (uint8_t)(1u << (i & 7u));
        }
    }
}

#if defined(__x86_64__)
static void sign_bits_sse2_impl(const float *vec, size_t dims, uint8_t *out_bits) {
    size_t byte_len = (dims + 7) >> 3;
    memset(out_bits, 0, byte_len);
    const __m128 zero = _mm_setzero_ps();
    size_t i = 0;
    for (; i + 8 <= dims; i += 8) {
        int m0 = _mm_movemask_ps(_mm_cmpge_ps(_mm_loadu_ps(vec + i), zero));
        int m1 = _mm_movemask_ps(_mm_cmpge_ps(_mm_loadu_ps(vec + i + 4), zero));
        out_bits[i >> 3] = (uint8_t)(m0 | (m1 << 4));
    }
    for (; i < dims; ++i) {
        if (vec[i] >= 0.0f) out_bits[i >> 3] |= (uint8_t)(1u << (i & 7u));
    }
}

__attribute__((target("avx2")))
static void sign_bits_avx2_impl(const float *vec, size_t dims, uint8_t *out_bits) {
    size_t byte_len = (dims + 7) >> 3;
    memset(out_bits, 0, byte_len);
    const __m256 zero = _mm256_setzero_ps();
    size_t i = 0;
    for (; i + 8 <= dims; i += 8) {
        __m256 cmp = _mm256_cmp_ps(_mm256_loadu_ps(vec + i), zero, _CMP_GE_OQ);
        out_bits[i >> 3] = (uint8_t)_mm256_movemask_ps(cmp);
    }
    for (; i < dims; ++i) {
        if (vec[i] >= 0.0f) out_bits[i >> 3] |= (uint8_t)(1u << (i & 7u));
    }
}
#endif  // __x86_64__

#if defined(__aarch64__)
static void sign_bits_neon_impl(const float *vec, size_t dims, uint8_t *out_bits) {
    size_t byte_len = (dims + 7) >> 3;
    memset(out_bits, 0, byte_len);
    const float32x4_t zero = vdupq_n_f32(0.0f);
    static const uint32_t weights_lo[4] = {1u, 2u, 4u, 8u};
    static const uint32_t weights_hi[4] = {16u, 32u, 64u, 128u};
    const uint32x4_t w_lo = vld1q_u32(weights_lo);
    const uint32x4_t w_hi = vld1q_u32(weights_hi);
    size_t i = 0;
    for (; i + 8 <= dims; i += 8) {
        uint32x4_t m0 = vandq_u32(vcgeq_f32(vld1q_f32(vec + i), zero), w_lo);
        uint32x4_t m1 = vandq_u32(vcgeq_f32(vld1q_f32(vec + i + 4), zero), w_hi);
        out_bits[i >> 3] = (uint8_t)vaddvq_u32(vorrq_u32(m0, m1));
    }
    for (; i < dims; ++i) {
        if (vec[i] >= 0.0f) out_bits[i >> 3] |= (uint8_t)(1u << (i & 7u));
    }
}
#endif  // __aarch64__

void adk_quantize_sign_bits_sse2(const float *vec, size_t dims, uint8_t *out_bits) {
#if defined(__x86_64__)
    sign_bits_sse2_impl(vec, dims, out_bits);
#else
    adk_quantize_sign_bits_scalar(vec, dims, out_bits);
#endif
}

void adk_quantize_sign_bits_avx2(const float *vec, size_t dims, uint8_t *out_bits) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_AVX2) {
        sign_bits_avx2_impl(vec, dims, out_bits);
        return;
    }
    sign_bits_sse2_impl(vec, dims, out_bits);
#else
    adk_quantize_sign_bits_scalar(vec, dims, out_bits);
#endif
}

void adk_quantize_sign_bits_neon(const float *vec, size_t dims, uint8_t *out_bits) {
#if defined(__aarch64__)
    sign_bits_neon_impl(vec, dims, out_bits);
#else
    adk_quantize_sign_bits_scalar(vec, dims, out_bits);
#endif
}

void adk_quantize_sign_bits(const float *vec, size_t dims, uint8_t *out_bits) {
    switch (adk_isa()) {
#if defined(__x86_64__)
        case ADK_ISA_X86_AVX2: sign_bits_avx2_impl(vec, dims, out_bits); return;
        case ADK_ISA_X86_SSE42:
        case ADK_ISA_X86_SSE2: sign_bits_sse2_impl(vec, dims, out_bits); return;
#elif defined(__aarch64__)
        case ADK_ISA_ARM_NEON: sign_bits_neon_impl(vec, dims, out_bits); return;
#endif
        default: adk_quantize_sign_bits_scalar(vec, dims, out_bits); return;
    }
}

// MARK: - 4b. `adk_quantize_i8` (exact JavaScript `Math.round` tie-breaking: halves toward +infinity)

static inline void adk_write_f32_le(float scale, uint8_t *dst) {
    uint32_t bits;
    memcpy(&bits, &scale, 4);
    dst[0] = (uint8_t)(bits & 0xFFu);
    dst[1] = (uint8_t)((bits >> 8) & 0xFFu);
    dst[2] = (uint8_t)((bits >> 16) & 0xFFu);
    dst[3] = (uint8_t)((bits >> 24) & 0xFFu);
}

static inline uint8_t adk_js_round_clamp_i8(double scaled) {
    double fl = floor(scaled);
    double r = (scaled - fl >= 0.5) ? (fl + 1.0) : fl;
    if (r > 127.0) r = 127.0;
    if (r < -127.0) r = -127.0;
    return (uint8_t)(int8_t)(int32_t)r;
}

void adk_quantize_i8_scalar(const float *vec, size_t dims, uint8_t *out_payload) {
    double amax = 0.0;
    for (size_t i = 0; i < dims; ++i) {
        double a = fabs((double)vec[i]);
        if (a > amax) amax = a;
    }
    double scale = (amax > 0.0) ? (amax / 127.0) : 1.0;
    double inv = (amax > 0.0) ? (127.0 / amax) : 0.0;
    for (size_t i = 0; i < dims; ++i) {
        out_payload[i] = adk_js_round_clamp_i8((double)vec[i] * inv);
    }
    adk_write_f32_le((float)scale, out_payload + dims);
}

#if defined(__x86_64__)
static void quantize_i8_sse2_impl(const float *vec, size_t dims, uint8_t *out_payload) {
    const __m128 sign_mask = _mm_set1_ps(-0.0f);
    __m128 vmax = _mm_setzero_ps();
    size_t i = 0;
    for (; i + 4 <= dims; i += 4) {
        vmax = _mm_max_ps(vmax, _mm_andnot_ps(sign_mask, _mm_loadu_ps(vec + i)));
    }
    float tmp[4];
    _mm_storeu_ps(tmp, vmax);
    double amax = 0.0;
    for (int k = 0; k < 4; ++k) {
        if ((double)tmp[k] > amax) amax = (double)tmp[k];
    }
    for (; i < dims; ++i) {
        double a = fabs((double)vec[i]);
        if (a > amax) amax = a;
    }
    double scale = (amax > 0.0) ? (amax / 127.0) : 1.0;
    double inv = (amax > 0.0) ? (127.0 / amax) : 0.0;
    for (size_t d = 0; d < dims; ++d) {
        out_payload[d] = adk_js_round_clamp_i8((double)vec[d] * inv);
    }
    adk_write_f32_le((float)scale, out_payload + dims);
}

__attribute__((target("avx2")))
static void quantize_i8_avx2_impl(const float *vec, size_t dims, uint8_t *out_payload) {
    const __m256 sign_mask = _mm256_set1_ps(-0.0f);
    __m256 vmax = _mm256_setzero_ps();
    size_t i = 0;
    for (; i + 8 <= dims; i += 8) {
        vmax = _mm256_max_ps(vmax, _mm256_andnot_ps(sign_mask, _mm256_loadu_ps(vec + i)));
    }
    float tmp[8];
    _mm256_storeu_ps(tmp, vmax);
    double amax = 0.0;
    for (int k = 0; k < 8; ++k) {
        if ((double)tmp[k] > amax) amax = (double)tmp[k];
    }
    for (; i < dims; ++i) {
        double a = fabs((double)vec[i]);
        if (a > amax) amax = a;
    }
    const __m256d vinv = _mm256_set1_pd((amax > 0.0) ? (127.0 / amax) : 0.0);
    const __m256d vhalf = _mm256_set1_pd(0.5);
    const __m256d vone = _mm256_set1_pd(1.0);
    const __m256d vmin_c = _mm256_set1_pd(-127.0);
    const __m256d vmax_c = _mm256_set1_pd(127.0);
    size_t d = 0;
    for (; d + 4 <= dims; d += 4) {
        __m256d scaled = _mm256_mul_pd(_mm256_cvtps_pd(_mm_loadu_ps(vec + d)), vinv);
        __m256d fl = _mm256_round_pd(scaled, _MM_FROUND_TO_NEG_INF | _MM_FROUND_NO_EXC);
        __m256d ge = _mm256_cmp_pd(_mm256_sub_pd(scaled, fl), vhalf, _CMP_GE_OQ);
        __m256d r = _mm256_add_pd(fl, _mm256_and_pd(ge, vone));
        r = _mm256_min_pd(vmax_c, _mm256_max_pd(vmin_c, r));
        __m128i i32 = _mm256_cvttpd_epi32(r);
        int32_t vals[4];
        _mm_storeu_si128((__m128i *)(void *)vals, i32);
        out_payload[d + 0] = (uint8_t)(int8_t)vals[0];
        out_payload[d + 1] = (uint8_t)(int8_t)vals[1];
        out_payload[d + 2] = (uint8_t)(int8_t)vals[2];
        out_payload[d + 3] = (uint8_t)(int8_t)vals[3];
    }
    double inv = (amax > 0.0) ? (127.0 / amax) : 0.0;
    for (; d < dims; ++d) {
        out_payload[d] = adk_js_round_clamp_i8((double)vec[d] * inv);
    }
    double scale = (amax > 0.0) ? (amax / 127.0) : 1.0;
    adk_write_f32_le((float)scale, out_payload + dims);
}
#endif  // __x86_64__

#if defined(__aarch64__)
static void quantize_i8_neon_impl(const float *vec, size_t dims, uint8_t *out_payload) {
    float32x4_t vmax = vdupq_n_f32(0.0f);
    size_t i = 0;
    for (; i + 4 <= dims; i += 4) {
        vmax = vmaxq_f32(vmax, vabsq_f32(vld1q_f32(vec + i)));
    }
    double amax = (double)vmaxvq_f32(vmax);
    for (; i < dims; ++i) {
        double a = fabs((double)vec[i]);
        if (a > amax) amax = a;
    }
    double scale = (amax > 0.0) ? (amax / 127.0) : 1.0;
    double inv = (amax > 0.0) ? (127.0 / amax) : 0.0;
    float64x2_t vinv = vdupq_n_f64(inv);
    float64x2_t vhalf = vdupq_n_f64(0.5);
    float64x2_t vone = vdupq_n_f64(1.0);
    float64x2_t vmin_c = vdupq_n_f64(-127.0);
    float64x2_t vmax_c = vdupq_n_f64(127.0);
    size_t d = 0;
    for (; d + 4 <= dims; d += 4) {
        float32x4_t v = vld1q_f32(vec + d);
        float64x2_t s0 = vmulq_f64(vcvt_f64_f32(vget_low_f32(v)), vinv);
        float64x2_t s1 = vmulq_f64(vcvt_high_f64_f32(v), vinv);
        float64x2_t f0 = vrndmq_f64(s0);
        float64x2_t f1 = vrndmq_f64(s1);
        float64x2_t r0 = vaddq_f64(f0, vreinterpretq_f64_u64(vandq_u64(vcgeq_f64(vsubq_f64(s0, f0), vhalf), vreinterpretq_u64_f64(vone))));
        float64x2_t r1 = vaddq_f64(f1, vreinterpretq_f64_u64(vandq_u64(vcgeq_f64(vsubq_f64(s1, f1), vhalf), vreinterpretq_u64_f64(vone))));
        r0 = vminq_f64(vmax_c, vmaxq_f64(vmin_c, r0));
        r1 = vminq_f64(vmax_c, vmaxq_f64(vmin_c, r1));
        int64x2_t i0 = vcvtq_s64_f64(r0);
        int64x2_t i1 = vcvtq_s64_f64(r1);
        out_payload[d + 0] = (uint8_t)(int8_t)vgetq_lane_s64(i0, 0);
        out_payload[d + 1] = (uint8_t)(int8_t)vgetq_lane_s64(i0, 1);
        out_payload[d + 2] = (uint8_t)(int8_t)vgetq_lane_s64(i1, 0);
        out_payload[d + 3] = (uint8_t)(int8_t)vgetq_lane_s64(i1, 1);
    }
    for (; d < dims; ++d) {
        out_payload[d] = adk_js_round_clamp_i8((double)vec[d] * inv);
    }
    adk_write_f32_le((float)scale, out_payload + dims);
}
#endif  // __aarch64__

void adk_quantize_i8_sse2(const float *vec, size_t dims, uint8_t *out_payload) {
#if defined(__x86_64__)
    quantize_i8_sse2_impl(vec, dims, out_payload);
#else
    adk_quantize_i8_scalar(vec, dims, out_payload);
#endif
}

void adk_quantize_i8_avx2(const float *vec, size_t dims, uint8_t *out_payload) {
#if defined(__x86_64__)
    if (adk_isa() >= ADK_ISA_X86_AVX2) {
        quantize_i8_avx2_impl(vec, dims, out_payload);
        return;
    }
    quantize_i8_sse2_impl(vec, dims, out_payload);
#else
    adk_quantize_i8_scalar(vec, dims, out_payload);
#endif
}

void adk_quantize_i8_neon(const float *vec, size_t dims, uint8_t *out_payload) {
#if defined(__aarch64__)
    quantize_i8_neon_impl(vec, dims, out_payload);
#else
    adk_quantize_i8_scalar(vec, dims, out_payload);
#endif
}

void adk_quantize_i8(const float *vec, size_t dims, uint8_t *out_payload) {
    switch (adk_isa()) {
#if defined(__x86_64__)
        case ADK_ISA_X86_AVX2: quantize_i8_avx2_impl(vec, dims, out_payload); return;
        case ADK_ISA_X86_SSE42:
        case ADK_ISA_X86_SSE2: quantize_i8_sse2_impl(vec, dims, out_payload); return;
#elif defined(__aarch64__)
        case ADK_ISA_ARM_NEON: quantize_i8_neon_impl(vec, dims, out_payload); return;
#endif
        default: adk_quantize_i8_scalar(vec, dims, out_payload); return;
    }
}
