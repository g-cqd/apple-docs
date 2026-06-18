import { describe, expect, test } from 'bun:test'
import { dotI8, hamming, quantize, quantizeI8, VECTOR_BYTES, VECTOR_DIMS } from '../../../src/search/embedding.js'

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

  test('honors width to compare a prefix only', () => {
    const a = new Uint8Array([0x00, 0xff])
    const b = new Uint8Array([0x00, 0x00])
    expect(hamming(a, b, 0, 1)).toBe(0) // first byte equal
    expect(hamming(a, b, 0, 2)).toBe(8) // second byte differs in all bits
  })
})

describe('quantizeI8 / dotI8', () => {
  test('layout is dims int8 + f32 scale, scale = absmax/127', () => {
    const v = new Float32Array([0, 1, -2, 0.5])
    const packed = quantizeI8(v)
    expect(packed.length).toBe(4 + 4)
    const scale = new DataView(packed.buffer, packed.byteOffset + 4, 4).getFloat32(0, true)
    expect(scale).toBeCloseTo(2 / 127)
    const i8 = new Int8Array(packed.buffer, packed.byteOffset, 4)
    expect(i8[1]).toBe(64) // 1 * 127/2 = 63.5 → round 64
    expect(i8[2]).toBe(-127) // the absmax maps to ±127
  })

  test('exact halves round away from zero (v2 semantics, mirrors Quantize.swift)', () => {
    // amax 2 → inv 63.5: ±1 hits exactly ±63.5. ECMA Math.round (the v1
    // mirror) sent -63.5 to -63; v2 rounds halves away from zero (RFC 0002 §6h).
    const packed = quantizeI8(new Float32Array([2, 1, -1]))
    const i8 = new Int8Array(packed.buffer, packed.byteOffset, 3)
    expect(i8[1]).toBe(64)
    expect(i8[2]).toBe(-64)
  })

  test('round-trips a vector dot to ≈ ||v||² within int8 tolerance', () => {
    const v = new Float32Array(VECTOR_DIMS)
    for (let i = 0; i < VECTOR_DIMS; i++) v[i] = Math.sin(i) // deterministic spread
    const packed = quantizeI8(v)
    let exact = 0
    for (let i = 0; i < VECTOR_DIMS; i++) exact += v[i] * v[i]
    const approx = dotI8(v, packed, 0, VECTOR_DIMS)
    expect(approx).toBeCloseTo(exact, 0) // within ~1 absolute on a ~256-magnitude dot
  })

  test('reads a record at a byte offset inside a multi-vector buffer', () => {
    const a = quantizeI8(new Float32Array([1, 0, 0, 0]))
    const b = quantizeI8(new Float32Array([0, 0, 0, 3]))
    const stride = a.length
    const both = new Uint8Array(stride * 2)
    both.set(a, 0)
    both.set(b, stride)
    const q = new Float32Array([0, 0, 0, 1])
    // q·a ≈ 0, q·b ≈ 3 (only the 4th dim aligns with b)
    expect(dotI8(q, both, 0, 4)).toBeCloseTo(0)
    expect(dotI8(q, both, stride, 4)).toBeCloseTo(3, 1)
  })

  test('all-zero vector is safe (no div-by-zero)', () => {
    const packed = quantizeI8(new Float32Array(4))
    expect(dotI8(new Float32Array([1, 1, 1, 1]), packed, 0, 4)).toBe(0)
  })
})
