#!/usr/bin/env bun
/**
 * Prerender bench (RFC 0003 §3 phase-2 gates): the in-dylib batch render
 * path vs the spawned worker pool, over a real catalog slice. Reports:
 *   - throughput (symbols/s) — gate: native ≥ pooled
 *   - peak in-process RSS during the native run — gate: bounded (the
 *     per-render autoreleasepool must keep one process flat across the
 *     whole slice, vs the pool's 4–16 short-lived processes)
 *   - byte parity — every output SVG identical between the two paths
 *
 * darwin-only (AppKit + a `swift` toolchain); needs a populated
 * $APPLE_DOCS_HOME DB for symbol names.
 *
 *   bun test/benchmarks/render-prerender-bench.js [--n 1500] [--variants 3]
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { renderScopeBucket, renderScopeBucketNative } from '../../src/resources/apple-symbols/prerender-engine.js'
import { symbolVariantMatrix } from '../../src/resources/apple-symbols/cache-key.js'
import { _forceImpl, nativeRenderAvailable } from '../../src/resources/render-native.js'

if (process.platform !== 'darwin') {
  console.error('prerender-bench: darwin only')
  process.exit(2)
}
const DEV_LIB = new URL(`../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
process.env.APPLE_DOCS_NATIVE_LIB ??= existsSync(DEV_LIB) ? DEV_LIB : process.env.APPLE_DOCS_NATIVE_LIB

const arg = (flag, def) => {
  const i = process.argv.indexOf(flag)
  return i > -1 ? Number.parseInt(process.argv[i + 1], 10) || def : def
}
const N = arg('--n', 1500)
const VARIANT_COUNT = arg('--variants', 3)

const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const db = new Database(join(home, 'apple-docs.db'), { readonly: true })
const symbols = db
  .query("SELECT name FROM sf_symbols WHERE scope='public' AND bitmap_only IS NOT 1 ORDER BY order_index")
  .all()
  .filter((_, i) => i % Math.max(1, Math.floor(8478 / N)) === 0)
  .slice(0, N)
  .map((r) => ({ name: r.name, scope: 'public' }))
const variants = symbolVariantMatrix('public').slice(0, VARIANT_COUNT)
const stubDb = { markSfSymbolBitmapOnly() {} }

function freshResult() {
  return { rendered: 0, skipped: 0, failed: 0, total: 0, symbols: symbols.length, failures: [] }
}

async function run(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'prerender-bench-'))
  const ctx = { dataDir: dir, db: stubDb }
  const result = freshResult()
  // The native path's batch FFI calls block the event loop, so a timer
  // sampler can't fire during them — track the end-of-run RSS too and take
  // the max (the sampler captures the async pooled path; end-RSS captures
  // the single blocking native process). /usr/bin/time -l is the rigorous
  // external check; this is the in-bench sanity number.
  let peakRss = 0
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 25)
  const t0 = performance.now()
  await fn({ scope: 'public', symbols, variants, ctx, concurrency: 8, logger: null, result })
  const ms = performance.now() - t0
  clearInterval(sampler)
  peakRss = Math.max(peakRss, process.memoryUsage().rss)
  return { dir, result, ms, peakRss }
}

function collectSvgs(dir) {
  const out = new Map()
  const base = join(dir, 'resources', 'symbols', 'public')
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name.endsWith('.svg')) out.set(p.slice(base.length), readFileSync(p))
    }
  }
  if (existsSync(base)) walk(base)
  return out
}

if (!nativeRenderAvailable()) {
  console.error('prerender-bench: native render unavailable (dylib/token) — cannot compare')
  process.exit(2)
}

console.log(`slice: ${symbols.length} symbols × ${variants.length} variants = ${symbols.length * variants.length} renders\n`)

_forceImpl('native')
const native = await run(renderScopeBucketNative)
_forceImpl('js') // force the pool path to actually spawn workers
const pooled = await run(renderScopeBucket)
_forceImpl(null)

const nThru = (native.result.rendered / native.ms) * 1000
const pThru = (pooled.result.rendered / pooled.ms) * 1000
const mb = (b) => (b / 1024 / 1024).toFixed(0)
console.log(`native: ${native.ms.toFixed(0)}ms  rendered ${native.result.rendered}  ${nThru.toFixed(0)}/s  peakRSS ${mb(native.peakRss)}MB`)
console.log(`pooled: ${pooled.ms.toFixed(0)}ms  rendered ${pooled.result.rendered}  ${pThru.toFixed(0)}/s  peakRSS ${mb(pooled.peakRss)}MB`)
console.log(`speedup: ${(pooled.ms / native.ms).toFixed(1)}×`)

// Byte parity across the two output trees.
const a = collectSvgs(native.dir)
const b = collectSvgs(pooled.dir)
let mismatch = 0
let compared = 0
const keys = new Set([...a.keys(), ...b.keys()])
for (const k of keys) {
  const x = a.get(k)
  const y = b.get(k)
  if (!x || !y || !x.equals(y)) {
    if (mismatch < 5) console.log(`  PARITY MISMATCH ${k} (native ${x?.length ?? 'missing'} vs pooled ${y?.length ?? 'missing'})`)
    mismatch++
  } else compared++
}
rmSync(native.dir, { recursive: true, force: true })
rmSync(pooled.dir, { recursive: true, force: true })

const thruOk = nThru >= pThru
const rssOk = native.peakRss <= pooled.peakRss || native.peakRss < 800 * 1024 * 1024
const parityOk = mismatch === 0 && compared > 0
console.log(`\nparity: ${compared} identical, ${mismatch} mismatch`)
console.log(`gates → throughput native≥pooled: ${thruOk ? 'MET' : 'FAILED'} | RSS bounded: ${rssOk ? 'MET' : 'FAILED'} | byte parity: ${parityOk ? 'MET' : 'FAILED'}`)
console.log(thruOk && rssOk && parityOk ? 'PRERENDER GATES: PASS' : 'PRERENDER GATES: FAIL')
process.exit(thruOk && rssOk && parityOk ? 0 : 1)
