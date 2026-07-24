/**
 * Pure, ONNX-free pooling + normalization helpers for the transformer
 * embedder backend (feature-extraction models). Kept separate from embedder.js
 * so the math is unit-testable without the optional `@huggingface/transformers`
 * dependency or any model download.
 *
 * A transformer's token output is a `[tokens × dims]` matrix; these collapse it
 * to a single `[dims]` sentence embedding (mean over real tokens, or the last
 * real token), then Matryoshka-truncate and L2-normalize for cosine/Hamming.
 */

/**
 * Attention-masked mean pooling over a flat `[tokens × dims]` row.
 * @param {Float32Array|number[]} data length tokens*dims (one sequence)
 * @param {number} dims
 * @param {ArrayLike<number>|null} [mask] per-token 1/0 (null ⇒ all real)
 * @returns {Float32Array} length dims
 */
export function meanPool(data, dims, mask = null) {
  const tokens = Math.floor(data.length / dims)
  const out = new Float32Array(dims)
  let count = 0
  for (let t = 0; t < tokens; t++) {
    if (mask && !mask[t]) continue
    const base = t * dims
    for (let d = 0; d < dims; d++) out[d] += data[base + d]
    count++
  }
  if (count > 0) for (let d = 0; d < dims; d++) out[d] /= count
  return out
}

/**
 * Last-real-token pooling (the convention for causal embedding models like
 * Qwen3-Embedding). Picks the highest masked-in token index.
 * @param {Float32Array|number[]} data length tokens*dims
 * @param {number} dims
 * @param {ArrayLike<number>|null} [mask]
 * @returns {Float32Array} length dims
 */
export function lastTokenPool(data, dims, mask = null) {
  const tokens = Math.floor(data.length / dims)
  let last = tokens - 1
  if (mask) {
    last = -1
    for (let t = tokens - 1; t >= 0; t--) {
      if (mask[t]) {
        last = t
        break
      }
    }
    if (last < 0) last = tokens - 1
  }
  const out = new Float32Array(dims)
  const base = last * dims
  for (let d = 0; d < dims; d++) out[d] = data[base + d]
  return out
}

/**
 * L2-normalize a vector (returns it unchanged when the norm is 0).
 * @param {Float32Array|number[]} vec
 * @returns {Float32Array}
 */
export function l2normalize(vec) {
  let n = 0
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i]
  n = Math.sqrt(n)
  const out = new Float32Array(vec.length)
  if (n === 0) {
    out.set(vec)
    return out
  }
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n
  return out
}

/**
 * Matryoshka truncation: keep the leading `dims` components. A no-op when the
 * vector is already ≤ dims. Returns a copy so callers can normalize freely.
 * @param {Float32Array} vec
 * @param {number} dims
 * @returns {Float32Array}
 */
export function truncate(vec, dims) {
  if (!dims || dims >= vec.length) return vec instanceof Float32Array ? vec : Float32Array.from(vec)
  return Float32Array.from(vec.subarray ? vec.subarray(0, dims) : vec.slice(0, dims))
}
