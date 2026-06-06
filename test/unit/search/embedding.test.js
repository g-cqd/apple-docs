import { describe, test, expect } from 'bun:test'
import { quantize, hamming, VECTOR_BYTES, VECTOR_DIMS } from '../../../src/search/embedding.js'

describe('quantize', () => {
  test('produces VECTOR_BYTES and sign bits in little-endian bit order', () => {
    const v = new Float32Array(VECTOR_DIMS)
    v[0] = 0.5 // bit 0 of byte 0
    v[1] = -0.5 // clear
    v[8] = 1 // bit 0 of byte 1
    const q = quantize(v)
    expect(q.length).toBe(VECTOR_BYTES)
    expect(q[0] & 1).toBe(1)
    expect((q[0] >> 1) & 1).toBe(0)
    expect(q[1] & 1).toBe(1)
  })
})

describe('hamming', () => {
  test('identical = 0, opposite = VECTOR_DIMS', () => {
    const qa = quantize(new Float32Array(VECTOR_DIMS).fill(1))
    const qb = quantize(new Float32Array(VECTOR_DIMS).fill(-1))
    expect(hamming(qa, qa)).toBe(0)
    expect(hamming(qa, qb)).toBe(VECTOR_DIMS)
  })

  test('counts differing bits', () => {
    expect(hamming(new Uint8Array([0b00000000, 0xff]), new Uint8Array([0b00000011, 0xff]))).toBe(2)
  })

  test('honors offsetB for packed-buffer scans', () => {
    const a = new Uint8Array([0xff, 0x00])
    const packed = new Uint8Array([0x00, 0xff, 0x00, 0x12])
    expect(hamming(a, packed, 1)).toBe(0)
  })
})
