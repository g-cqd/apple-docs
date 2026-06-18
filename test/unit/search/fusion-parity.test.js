// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * A/B parity: the native fusion implementation must be indistinguishable
 * from the JS reference — Object.is on every score, identical Map insertion
 * order, identical MMR permutations — across fixed vectors and seeded
 * property cases. Skips when no dylib is built (CI builds one first).
 */

import { suffix } from 'bun:ffi'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { _resetNativeLoader } from '../../../src/native/loader.js'
import { hybridFusion as jsHybrid, mmrSelect as jsMmr, weightedRRF as jsRRF } from '../../../src/search/fusion.js'
import { _forceImpl, _nativeCallCount, hammingSim, hybridFusion, mmrSelect, weightedRRF } from '../../../src/search/fusion-native.js'

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomLists(rand) {
  const idCount = 1 + Math.floor(rand() * 40)
  const ids = Array.from({ length: idCount }, (_, i) => `doc/${i}`)
  const listCount = 1 + Math.floor(rand() * 4)
  return Array.from({ length: listCount }, () => {
    const ranked = [...ids].sort(() => rand() - 0.5).slice(0, 1 + Math.floor(rand() * idCount))
    const withScores = rand() < 0.6
    const scores = withScores ? new Map(ranked.map((key) => [key, rand() * 10 - 2])) : undefined
    return { ranked, weight: rand() * 2, ...(scores ? { scores } : {}) }
  })
}

function expectMapsIdentical(actual, expected) {
  expect([...actual.keys()]).toEqual([...expected.keys()])
  const a = [...actual.values()]
  const b = [...expected.values()]
  for (let i = 0; i < b.length; i++) {
    if (!Object.is(a[i], b[i])) {
      throw new Error(`value drift at ${i}: native=${a[i]} js=${b[i]}`)
    }
  }
}

describe.skipIf(!existsSync(DEV_LIB))('fusion native/js parity', () => {
  beforeAll(() => {
    _resetNativeLoader()
    _forceImpl('native')
  })
  afterAll(() => {
    _forceImpl(null)
    _resetNativeLoader()
  })

  test('weightedRRF fixed vectors', () => {
    const lists = [
      { ranked: ['a', 'b', 'c'], weight: 1.0 },
      { ranked: ['b', 'd'], weight: 0.6 },
    ]
    const before = _nativeCallCount()
    expectMapsIdentical(weightedRRF(lists), jsRRF(lists))
    expect(_nativeCallCount()).toBe(before + 1) // native actually served
  })

  test('hybridFusion fixed vectors', () => {
    const lists = [
      {
        ranked: ['a', 'b', 'c'],
        weight: 1.0,
        scores: new Map([
          ['a', 5],
          ['b', 2],
          ['c', 1],
        ]),
      },
      {
        ranked: ['b', 'd'],
        weight: 0.6,
        scores: new Map([
          ['b', 0.9],
          ['d', 0.1],
        ]),
      },
    ]
    const before = _nativeCallCount()
    expectMapsIdentical(hybridFusion(lists, { k: 60, beta: 0.5 }), jsHybrid(lists, { k: 60, beta: 0.5 }))
    expect(_nativeCallCount()).toBe(before + 1)
  })

  test('rrf ignores scores exactly like JS', () => {
    const lists = [
      {
        ranked: ['a', 'b'],
        weight: 1.0,
        scores: new Map([
          ['a', 9],
          ['b', 1],
        ]),
      },
    ]
    expectMapsIdentical(weightedRRF(lists), jsRRF(lists))
  })

  test('misaligned scores fall back to JS (and still match it)', () => {
    const lists = [
      { ranked: ['a', 'b'], weight: 1.0, scores: new Map([['a', 1]]) }, // size mismatch
    ]
    const before = _nativeCallCount()
    expectMapsIdentical(hybridFusion(lists), jsHybrid(lists))
    expect(_nativeCallCount()).toBe(before) // codec guard → js path
  })

  test('empty inputs', () => {
    expectMapsIdentical(weightedRRF([]), jsRRF([]))
    expectMapsIdentical(hybridFusion([{ ranked: [], weight: 1 }]), jsHybrid([{ ranked: [], weight: 1 }]))
  })

  test('200 seeded property cases — rrf + hybrid', () => {
    const rand = mulberry32(0xad0c5)
    for (let i = 0; i < 200; i++) {
      const lists = randomLists(rand)
      const k = rand() < 0.5 ? 60 : 1 + rand() * 100
      const beta = rand() < 0.34 ? 0 : rand()
      expectMapsIdentical(weightedRRF(lists, { k }), jsRRF(lists, { k }))
      expectMapsIdentical(hybridFusion(lists, { k, beta }), jsHybrid(lists, { k, beta }))
    }
  })

  test('mmr fixed vectors incl. null vecs and ties', () => {
    const vecs = {
      p: Uint8Array.from([255, 255]),
      q: Uint8Array.from([255, 255]),
      r: Uint8Array.from([0, 0]),
      s: null,
    }
    const items = ['p', 'q', 'r', 's']
    const vecOf = (it) => vecs[it]
    const before = _nativeCallCount()
    expect(mmrSelect(items, vecOf, hammingSim, { lambda: 0.3 })).toEqual(jsMmr(items, vecOf, hammingSim, { lambda: 0.3 }))
    expect(_nativeCallCount()).toBe(before + 1)
    expect(mmrSelect(items, vecOf, hammingSim, { lambda: 0.3, limit: 3 })).toEqual(jsMmr(items, vecOf, hammingSim, { lambda: 0.3, limit: 3 }))
  })

  test('custom sim stays on JS', () => {
    const items = ['a', 'b', 'c']
    const vecOf = () => Uint8Array.from([1])
    const customSim = () => 0.5
    const before = _nativeCallCount()
    expect(mmrSelect(items, vecOf, customSim, {})).toEqual(jsMmr(items, vecOf, customSim, {}))
    expect(_nativeCallCount()).toBe(before)
  })

  test('200 seeded property cases — mmr', () => {
    const rand = mulberry32(0xfade)
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * 30)
      const dim = [1, 2, 8][Math.floor(rand() * 3)]
      const items = Array.from({ length: n }, (_, j) => `item/${j}`)
      const vecs = items.map(() => (rand() < 0.2 ? null : Uint8Array.from({ length: dim }, () => Math.floor(rand() * 256))))
      const vecOf = (it) => vecs[items.indexOf(it)]
      const lambda = rand()
      const limit = rand() < 0.5 ? undefined : 1 + Math.floor(rand() * n)
      const opts = limit === undefined ? { lambda } : { lambda, limit }
      expect(mmrSelect(items, vecOf, hammingSim, opts)).toEqual(jsMmr(items, vecOf, hammingSim, opts))
    }
  })
})
