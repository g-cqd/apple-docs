/**
 * Fusion js-vs-native micro-benchmark (packing cost included on the native
 * side — that is the price callers actually pay). Run:
 *
 *   swift build -c release --package-path swift
 *   bun test/benchmarks/fusion-bench.js
 */

import { suffix } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { _resetNativeLoader } from '../../src/native/loader.js'
import { hybridFusion as jsHybrid, mmrSelect as jsMmr } from '../../src/search/fusion.js'
import { _forceImpl, hammingSim, hybridFusion, mmrSelect } from '../../src/search/fusion-native.js'

const DEV_LIB = new URL(`../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
if (!existsSync(DEV_LIB)) {
  console.error(`no dylib at ${DEV_LIB} — build it first`)
  process.exit(1)
}
_resetNativeLoader()
_forceImpl('native')

function makeLists(n) {
  const ids = Array.from({ length: n }, (_, i) => `documentation/swiftui/item${i}`)
  const semantic = [...ids].reverse().slice(0, Math.ceil(n * 0.8))
  return [
    { ranked: ids, weight: 1.0, scores: new Map(ids.map((id, i) => [id, 1 - i / n])) },
    { ranked: semantic, weight: 0.6, scores: new Map(semantic.map((id, i) => [id, 0.9 - i / n])) },
  ]
}

function makeMmrInput(n, dim = 16) {
  const items = Array.from({ length: n }, (_, i) => `item/${i}`)
  const vecs = new Map(items.map((it, i) => [it, i % 5 === 0 ? null : Uint8Array.from({ length: dim }, (_, j) => (i * 31 + j * 7) % 256)]))
  return { items, vecOf: (it) => vecs.get(it) ?? null }
}

function bench(label, fn, iters = 5_000) {
  for (let i = 0; i < iters / 10; i++) fn()
  const times = []
  for (let batch = 0; batch < 10; batch++) {
    const t = Bun.nanoseconds()
    for (let i = 0; i < iters / 10; i++) fn()
    times.push((Bun.nanoseconds() - t) / (iters / 10))
  }
  times.sort((a, b) => a - b)
  const fmt = (ns) => (ns < 1000 ? `${ns.toFixed(0)} ns` : `${(ns / 1000).toFixed(2)} µs`)
  console.log(`${label.padEnd(34)} p50 ${fmt(times[5])}  p95 ${fmt(times[9])}`)
  return times[5]
}

console.log(`fusion bench · bun ${Bun.version} · ${process.platform}-${process.arch}\n`)
for (const n of [10, 100]) {
  const lists = makeLists(n)
  const native = bench(`hybridFusion native  n=${n}`, () => hybridFusion(lists))
  const js = bench(`hybridFusion js      n=${n}`, () => jsHybrid(lists))
  console.log(`  ratio native/js: ${(native / js).toFixed(2)}\n`)
}
for (const n of [20, 100]) {
  const { items, vecOf } = makeMmrInput(n)
  const native = bench(`mmrSelect native     n=${n}`, () => mmrSelect(items, vecOf, hammingSim, { lambda: 0.7 }), 2_000)
  const js = bench(`mmrSelect js         n=${n}`, () => jsMmr(items, vecOf, hammingSim, { lambda: 0.7 }), 2_000)
  console.log(`  ratio native/js: ${(native / js).toFixed(2)}\n`)
}
_forceImpl(null)
