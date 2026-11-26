//
//  CAppleDocsKernels.h
//  CAppleDocsKernels
//
//  Runtime-dispatched SIMD numerical, Hamming, Levenshtein, and HTML-escaping kernels modeled on
//  `CAemiKernels`. Every public operation dispatches to the widest ISA present on the host CPU at
//  runtime (`pthread_once`-cached):
//    - arm64: NEON (`vcntq_u8` / `vpaddlq` / `vmlaq_f32` / `vmovl_s8`)
//    - x86-64: SSE2, SSE4.2 (`popcnt` + `pshufb`), AVX2 + FMA (`_mm256_shuffle_epi8`, `_mm256_fmadd_ps`)
//    - fallback: portable C11 scalar reference (differential-test oracle).
//
//  Every named backend (`_scalar`, `_sse2`, `_sse42`, `_avx2`, `_neon`) self-guards: calling `_avx2`
//  on an arm64 or SSE2-only host falls back cleanly without trapping.
//

#ifndef C_APPLE_DOCS_KERNELS_H
#define C_APPLE_DOCS_KERNELS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ADK_ISA_SCALAR = 0,
    ADK_ISA_X86_SSE2 = 1,
    ADK_ISA_X86_SSE42 = 2,
    ADK_ISA_X86_AVX2 = 3,
    ADK_ISA_ARM_NEON = 4
} adk_isa_t;

/// Returns the cached runtime ISA tier (`adk_isa_t`) for the current CPU.
int adk_isa(void);

/// Returns a human-readable backend label (`"neon"`, `"avx2"`, `"sse4.2"`, `"sse2"`, `"scalar"`).
const char *adk_backend(void);

// MARK: - 1. Batch Hamming distance over packed sign-bit codes

/// Computes `out_distances[r] = popcount(query[0..<byte_width] ^ packed[r*byte_width ..< (r+1)*byte_width])`
/// for `r` in `0..<row_count`. Specializes `byte_width == 64` (512-bit Model2Vec codes) and `byte_width == 32`
/// (256-bit codes) with unrolled SIMD loops (`vcntq_u8` on NEON, `pshufb` nibble LUT on AVX2/SSSE3, `popcnt64`
/// on SSE4.2), falling back to a general arbitrary-width loop otherwise.
void adk_hamming_batch(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);

void adk_hamming_batch_scalar(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);
void adk_hamming_batch_sse2(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);
void adk_hamming_batch_sse42(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);
void adk_hamming_batch_avx2(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);
void adk_hamming_batch_neon(
    const uint8_t *query,
    const uint8_t *packed,
    size_t row_count,
    size_t byte_width,
    uint16_t *out_distances);

// MARK: - 2. Int8 dot-product rescoring (`dot(f32[dims], i8[dims]) * f32_scale`)

/// Computes `(sum_{d=0..<dims} (double)query[d] * (double)codes[d]) * (double)scale`, matching Bun's
/// `dotI8` double-precision accumulation exactly.
double adk_dot_f32_i8(const float *query, const int8_t *codes, size_t dims, float scale);
double adk_dot_f32_i8_scalar(const float *query, const int8_t *codes, size_t dims, float scale);
double adk_dot_f32_i8_sse2(const float *query, const int8_t *codes, size_t dims, float scale);
double adk_dot_f32_i8_avx2(const float *query, const int8_t *codes, size_t dims, float scale);
double adk_dot_f32_i8_neon(const float *query, const int8_t *codes, size_t dims, float scale);

// MARK: - 3. Model2Vec Q8 embedding gather + mean-pool + L2-normalize

/// Gathers `id_count` token rows from a compact `M2VQ8` weight table (`rows * dims` signed int8 values +
/// `rows` float32 scales; out-of-range IDs map to row 0), accumulates `(double)((float)q * scale)` per
/// dimension, divides by `id_count` into float32, and L2-normalizes in double precision into `out_vec[0..<dims]`.
/// Bit-identical to Bun's `model2vec-static.js` over `parseQ8Matrix`.
void adk_q8_pool_l2(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec);

void adk_q8_pool_l2_scalar(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec);
void adk_q8_pool_l2_sse2(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec);
void adk_q8_pool_l2_avx2(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec);
void adk_q8_pool_l2_neon(
    const int32_t *token_ids,
    size_t id_count,
    const int8_t *q8_data,
    const float *row_scales,
    size_t rows,
    size_t dims,
    float *out_vec);

// MARK: - 4. Sign-bit & symmetric int8 quantization (`quantizeTo` + `quantizeI8`)

/// Packs sign bits of `vec[0..<dims]` into `out_bits[0..<(dims+7)/8]`: bit `(i & 7)` of byte `(i >> 3)` is 1
/// iff `vec[i] >= 0.0f` (matching Bun `quantizeTo`).
void adk_quantize_sign_bits(const float *vec, size_t dims, uint8_t *out_bits);
void adk_quantize_sign_bits_scalar(const float *vec, size_t dims, uint8_t *out_bits);
void adk_quantize_sign_bits_sse2(const float *vec, size_t dims, uint8_t *out_bits);
void adk_quantize_sign_bits_avx2(const float *vec, size_t dims, uint8_t *out_bits);
void adk_quantize_sign_bits_neon(const float *vec, size_t dims, uint8_t *out_bits);

/// Quantizes `vec[0..<dims]` into `out_payload[0..<dims + 4]`: `dims` signed int8 bytes using JavaScript
/// `Math.round` (`floor(x + 0.5)` tie-breaking toward +infinity) over `(double)vec[i] * (127.0 / amax)`
/// followed by little-endian float32 `scale = (float)(amax > 0 ? amax / 127.0 : 1.0)`.
void adk_quantize_i8(const float *vec, size_t dims, uint8_t *out_payload);
void adk_quantize_i8_scalar(const float *vec, size_t dims, uint8_t *out_payload);
void adk_quantize_i8_sse2(const float *vec, size_t dims, uint8_t *out_payload);
void adk_quantize_i8_avx2(const float *vec, size_t dims, uint8_t *out_payload);
void adk_quantize_i8_neon(const float *vec, size_t dims, uint8_t *out_payload);

// MARK: - 5. Myers 64-bit bit-parallel Levenshtein over UTF-16 code units

/// Bounded edit distance over `lhs[0..<lhs_len]` and `rhs[0..<rhs_len]`, returning a value `> max_dist`
/// (`max_dist + 1`) as soon as the true edit distance is proven to exceed `max_dist`. Uses Hyyrö/Myers
/// 64-bit bit-parallel word transitions when `lhs_len <= 64`, falling back to banded DP with early row exit.
int32_t adk_levenshtein_u16(
    const uint16_t *lhs,
    size_t lhs_len,
    const uint16_t *rhs,
    size_t rhs_len,
    int32_t max_dist);

#ifdef __cplusplus
}
#endif

#endif  // C_APPLE_DOCS_KERNELS_H
