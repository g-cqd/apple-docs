// RFC 0001 P5 GO/NO-GO measurement: native (libsqlite3 via bun:ffi) vs
// bun:sqlite for searchPages, same SQL + same data. Both run the identical
// FTS5 statement; the delta is the FFI boundary tax (pack request + frame
// rows + decode) vs bun:sqlite's in-C row build. Direct main-thread timing
// (the §10 measure-first discipline: trust direct wall-clock over a sampler).
//
//   bun scripts/storage-search-bench.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _resetNativeLoader } from '../src/native/loader.js'
import { DocsDatabase } from '../src/storage/database.js'
import { _forceImpl, nativeSearchPages, nativeStorageClose, nativeStorageOpen } from '../src/storage/storage-native.js'

const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'coredata', 'mapkit', 'avfoundation', 'metal']
const TERMS = ['view', 'data', 'model', 'render', 'layer', 'object', 'value', 'controller', 'animation', 'image']
const DOCS_PER_FW = 60

process.env.APPLE_DOCS_NATIVE_LIB ??= new URL(`../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
_resetNativeLoader()
_forceImpl('native')

const dir = mkdtempSync(join(tmpdir(), 'storage-bench-'))
const dbPath = join(dir, 'corpus.db')
const db = new DocsDatabase(dbPath)

for (const fw of FRAMEWORKS) db.upsertRoot(fw, fw.toUpperCase(), 'framework', 'bench')
let n = 0
for (const fw of FRAMEWORKS) {
  for (let i = 0; i < DOCS_PER_FW; i++) {
    const t1 = TERMS[i % TERMS.length]
    const t2 = TERMS[(i * 3) % TERMS.length]
    db.upsertDocument({
      key: `${fw}/sym${i}`,
      title: `${t1[0].toUpperCase()}${t1.slice(1)}${i}`,
      framework: fw,
      sourceType: i % 5 === 0 ? 'wwdc' : 'apple-docc',
      role: 'symbol',
      kind: i % 2 === 0 ? 'struct' : 'class',
      language: i % 3 === 0 ? 'occ' : 'swift',
      abstractText: `A ${t1} that manages ${t2} for the ${fw} layer with view data and rendering.`,
      urlDepth: 2,
      minIos: `${13 + (i % 5)}.0`,
      isDeprecated: i % 11 === 0,
    })
    n++
  }
}

const handle = nativeStorageOpen(dbPath)
if (handle == null) {
  console.error('native handle unavailable — dylib/FTS5 missing'); process.exit(1)
}

// Workload: a "search unit" fans the term across every framework filter
// (mimicking the cascade's per-framework calls — the ×F boundary tax).
function jsUnit(term) {
  let rows = 0
  for (const fw of FRAMEWORKS) rows += db.searchPages(term, term, { framework: fw, limit: 100 }).length
  return rows
}
function nativeUnit(term) {
  let rows = 0
  for (const fw of FRAMEWORKS) rows += nativeSearchPages(handle, term, term, { framework: fw, limit: 100 }).length
  return rows
}

// Sanity: identical row counts.
let mismatch = false
for (const term of TERMS) if (jsUnit(term) !== nativeUnit(term)) mismatch = true
console.log(`seed: ${n} docs / ${FRAMEWORKS.length} frameworks; row-count parity: ${mismatch ? 'MISMATCH' : 'ok'}`)

function bench(fn) {
  for (let i = 0; i < 200; i++) fn(TERMS[i % TERMS.length]) // warm
  const samples = []
  const ITERS = 3000
  for (let i = 0; i < ITERS; i++) {
    const term = TERMS[i % TERMS.length]
    const t0 = performance.now()
    fn(term)
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const pct = (p) => samples[Math.floor(samples.length * p)]
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length
  return { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), mean }
}

const js = bench(jsUnit)
const nat = bench(nativeUnit)
const f = (x) => x.toFixed(4)
console.log(`\nsearch-unit latency (ms), ${FRAMEWORKS.length} framework calls each:`)
console.log(`  bun:sqlite  p50=${f(js.p50)}  p95=${f(js.p95)}  p99=${f(js.p99)}  mean=${f(js.mean)}`)
console.log(`  native FFI  p50=${f(nat.p50)}  p95=${f(nat.p95)}  p99=${f(nat.p99)}  mean=${f(nat.mean)}`)
console.log(`  native/js   p50=${(nat.p50 / js.p50).toFixed(2)}x  mean=${(nat.mean / js.mean).toFixed(2)}x  (>1 = native slower)`)

nativeStorageClose(handle)
db.close()
rmSync(dir, { recursive: true, force: true })
