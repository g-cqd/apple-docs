/**
 * Output-identity lock for RFC 0001 §10 slice 1 (Hamming-scan perf): the
 * SWAR `Uint32` popcount must equal the byte-LUT `hamming`, and the
 * max-heap `shortlistByHamming` must reproduce the old O(K)-splice
 * insertion-sort byte-for-byte — same K-smallest set AND order, including
 * the strict `d < worst` admission and the (dist asc, idx asc) tie order.
 */

import { describe, expect, test } from 'bun:test'
import { hamming, hammingU32 } from '../../../src/search/embedding.js'
import { _test } from '../../../src/search/semantic.js'

// Deterministic xorshift PRNG so the property cases are reproducible.
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x1_0000_0000
  }
}

function randomCodes(rand, n, width, bias = 0.5) {
  const packed = new Uint8Array(n * width)
  for (let i = 0; i < packed.length; i++) packed[i] = rand() < bias ? rand() * 256 : 0
  return packed
}

// Reference: the pre-§10(B)-slice-1 implementation (byte-LUT + insertion sort).
function refShortlist(qBin, packed, width, n, K) {
  const idx = []
  const dist = []
  let worst = Infinity
  const insert = (j, d) => {
    let lo = 0
    let hi = dist.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (dist[m] <= d) lo = m + 1
      else hi = m
    }
    idx.splice(lo, 0, j)
    dist.splice(lo, 0, d)
  }
  for (let i = 0; i < n; i++) {
    const d = hamming(qBin, packed, i * width, width)
    if (idx.length < K) {
      insert(i, d)
      worst = dist[dist.length - 1]
    } else if (d < worst) {
      idx.pop()
      dist.pop()
      insert(i, d)
      worst = dist[dist.length - 1]
    }
  }
  return idx.map((j, r) => ({ idx: j, dist: dist[r] }))
}

describe('SWAR popcount parity', () => {
  test('hammingU32 == hamming across widths and bit densities', () => {
    const rand = rng(42)
    for (const width of [4, 8, 32, 64, 128]) {
      const words = width >> 2
      for (let t = 0; t < 200; t++) {
        const a = randomCodes(rand, 1, width, rand())
        const b = randomCodes(rand, 1, width, rand())
        const aW = new Uint32Array(a.buffer, a.byteOffset, words)
        const bW = new Uint32Array(b.buffer, b.byteOffset, words)
        expect(hammingU32(aW, bW, 0, words)).toBe(hamming(a, b, 0, width))
      }
    }
  })
})

describe('shortlistByHamming == reference (byte-identical incl. ties)', () => {
  // Tie-heavy: small widths → few distinct Hamming distances → exercises the
  // strict-admission + tail-eviction tie semantics. Mix SWAR (width %4===0)
  // and byte-LUT (width 3) paths; n<K, n==K, n>>K.
  const cases = [
    { width: 4, n: 500, K: 50 },
    { width: 3, n: 500, K: 50 }, // byte-LUT fallback (not word-aligned)
    { width: 8, n: 2000, K: 200 },
    { width: 64, n: 3000, K: 200 },
    { width: 64, n: 30, K: 200 }, // n < K
    { width: 64, n: 200, K: 200 }, // n == K
    { width: 4, n: 4000, K: 16, bias: 0.5 }, // many ties at the boundary
  ]
  for (const c of cases) {
    test(`width=${c.width} n=${c.n} K=${c.K}`, () => {
      const rand = rng(c.width * 1000 + c.n + c.K)
      for (let seed = 0; seed < 12; seed++) {
        const packed = randomCodes(rand, c.n, c.width, c.bias ?? rand() * 0.5 + 0.25)
        const qBin = randomCodes(rand, 1, c.width, rand())
        const got = _test.shortlistByHamming(qBin, packed, c.width, c.n, c.K)
        const ref = refShortlist(qBin, packed, c.width, c.n, c.K)
        expect(got).toEqual(ref)
      }
    })
  }
})
