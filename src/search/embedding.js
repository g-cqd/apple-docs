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

/**
 * Width-aware sign-quantization for variable-dimension codes (chunks /
 * Matryoshka-truncated transformer embeddings). Produces `ceil(dims/8)` bytes.
 * `quantize` is the fixed-512 special case kept for the legacy whole-doc path.
 * @param {Float32Array|number[]} vec
 * @param {number} [dims=vec.length]
 * @returns {Uint8Array} length ceil(dims/8)
 */
export function quantizeTo(vec, dims = vec.length) {
  const out = new Uint8Array(Math.ceil(dims / 8))
  const n = Math.min(vec.length, dims)
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
 * @param {number} [width] bytes to compare (defaults to a.length)
 * @returns {number} number of differing bits (0..width*8)
 */
export function hamming(a, b, offsetB = 0, width = a.length) {
  let d = 0
  for (let i = 0; i < width; i++) d += POPCOUNT[a[i] ^ b[offsetB + i]]
  return d
}

/**
 * Hamming distance over 32-bit words via a SWAR popcount — same result as
 * `hamming` (verified bit-for-bit) but ~2.6× faster on the resident-store
 * scan: 16 word ops vs 64 byte-LUT lookups for a 64-byte code (RFC 0001
 * §10 slice 1, the measured popcount lever). The caller builds aligned
 * `Uint32Array` views once and passes a word offset; requires the byte
 * width to be a multiple of 4 (true for all current code widths).
 * @param {Uint32Array} qWords query code as 32-bit words
 * @param {Uint32Array} packedWords resident codes as 32-bit words
 * @param {number} base word offset of this doc's code (= docIndex * words)
 * @param {number} words words per code (= byteWidth / 4)
 */
export function hammingU32(qWords, packedWords, base, words) {
  let d = 0
  for (let k = 0; k < words; k++) {
    let v = qWords[k] ^ packedWords[base + k]
    v = v - ((v >>> 1) & 0x5555_5555)
    v = (v & 0x3333_3333) + ((v >>> 2) & 0x3333_3333)
    d += (((v + (v >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24
  }
  return d
}

/**
 * Per-vector int8 quantization for the rescore stage of the SOTA
 * "binary-retrieve → int8-rescore" pipeline. The binary code answers *which*
 * docs to consider (cheap Hamming); int8 recovers the magnitude the sign bits
 * threw away (~96% of full-precision quality vs ~92.5% binary-only).
 *
 * Layout: `[int8 × dims][f32 scale]` — `dims` signed bytes followed by a
 * little-endian f32 absmax scale, so a doc vector packs to `dims + 4` bytes.
 * The scale is the per-vector absolute max / 127, making quantization
 * order-independent and corpus-calibration-free → snapshot-stable / bit-
 * identical across the determinism gate's two passes.
 *
 * Mirrors swift/Sources/ADEmbed/Quantize.swift (normative since embedding
 * v2): exact halves round AWAY FROM ZERO, not ECMA Math.round's toward-+∞
 * (RFC 0002 §6h) — change both sides together.
 *
 * @param {Float32Array|number[]} vec
 * @returns {Uint8Array} length `vec.length + 4`
 */
export function quantizeI8(vec) {
  const n = vec.length
  const buf = new ArrayBuffer(n + 4)
  const i8 = new Int8Array(buf, 0, n)
  let amax = 0
  for (let i = 0; i < n; i++) {
    const a = vec[i] < 0 ? -vec[i] : vec[i]
    if (a > amax) amax = a
  }
  const scale = amax > 0 ? amax / 127 : 1
  const inv = amax > 0 ? 127 / amax : 0
  for (let i = 0; i < n; i++) {
    const x = vec[i] * inv
    let q = Math.sign(x) * Math.round(Math.abs(x))
    if (q > 127) q = 127
    else if (q < -127) q = -127
    i8[i] = q
  }
  new DataView(buf).setFloat32(n, scale, true)
  return new Uint8Array(buf)
}

/**
 * Dot product of a full-precision query against a packed int8 doc vector
 * (the rescore step). Reads `dims` signed bytes at `off` plus the trailing f32
 * scale; returns `scale · Σ q[i]·i8[i]`, which ranks identically to cosine for
 * a fixed query (the query norm is constant across the shortlist).
 *
 * @param {Float32Array} qFp32 query embedding, length ≥ dims
 * @param {Uint8Array} packed buffer holding one or more `[int8×dims][f32]` records
 * @param {number} off byte offset of this record within `packed`
 * @param {number} dims embedding width
 * @returns {number}
 */
export function dotI8(qFp32, packed, off, dims) {
  const base = packed.byteOffset + off
  const i8 = new Int8Array(packed.buffer, base, dims)
  const scale = new DataView(packed.buffer, base + dims, 4).getFloat32(0, true)
  let dot = 0
  for (let i = 0; i < dims; i++) dot += qFp32[i] * i8[i]
  return dot * scale
}
