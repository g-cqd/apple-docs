/**
 * Binary embedding primitives for the semantic tier (pure JS, no deps).
 *
 * A 512-d float embedding (from the model2vec static embedder) is
 * sign-quantized to 512 bits = 64 bytes: bit i = 1 iff dim i >= 0.
 * Similarity is then Hamming distance (XOR + popcount), which closely tracks
 * cosine for normalized vectors and is trivially fast over a packed
 * Uint8Array. (Was 384-d / 48-byte under all-MiniLM-L6-v2; the wider code
 * measurably improves recall at full-corpus scale — see search/embedder.js.)
 */

export const VECTOR_DIMS = 512
export const VECTOR_BYTES = VECTOR_DIMS / 8 // 64

/**
 * Sign-quantize a float embedding into a packed bit vector.
 * @param {Float32Array|number[]} vec
 * @returns {Uint8Array} length VECTOR_BYTES
 */
export function quantize(vec) {
  const out = new Uint8Array(VECTOR_BYTES)
  const n = Math.min(vec.length, VECTOR_DIMS)
  for (let i = 0; i < n; i++) {
    if (vec[i] >= 0) out[i >> 3] |= 1 << (i & 7)
  }
  return out
}

// 8-bit popcount lookup table.
const POPCOUNT = new Uint8Array(256)
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1]

/**
 * Hamming distance between two equal-length packed bit vectors.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @param {number} [offsetB] start offset of b within its buffer (for packed scans)
 * @returns {number} number of differing bits (0..VECTOR_DIMS)
 */
export function hamming(a, b, offsetB = 0) {
  let d = 0
  for (let i = 0; i < a.length; i++) d += POPCOUNT[a[i] ^ b[offsetB + i]]
  return d
}
