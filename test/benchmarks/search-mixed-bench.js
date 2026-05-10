/**
 * Mixed-load benchmark — SLO + heavy fuzzy/body interleaved.
 *
 * Phase 1.4 of docs/plans/2026-05-10-javascript-performance-sota.md.
 *
 * The research doc shows that with fuzzy/body enabled in the same reader
 * pool as cheap searches, SLO p99 explodes from ~5 ms (concurrency=1) to
 * ~1968 ms (concurrency=8). This benchmark locks in the regression
 * surface so phase 2 (split reader pools) has something to demonstrate
 * an improvement against.
 *
 * What it measures:
 *   - SLO p50/p95/p99 — cheap title/path searches.
 *   - HEAVY p50/p95/p99 — fuzzy + body searches.
 *   - Wall-clock + CPU time per concurrency level.
 *
 * Cases run in 4:1 SLO:HEAVY ratio by default — close to typical traffic
 * mix where most queries are cheap. Override the ratio via `--ratio
 * <slo:heavy>` (e.g. `--ratio 1:1` for an adversarial mix).
 *
 * Direct-mode only — bypasses the HTTP layer so the measurement isolates
 * the search cascade + reader pool. Pass `--readers <n>` to size the pool
 * explicitly; default is 4.
 *
 * Usage:
 *   bun test/benchmarks/search-mixed-bench.js --concurrency 1,4,8,16 --iterations 100
 *   bun test/benchmarks/search-mixed-bench.js --ratio 4:1 --readers 4 --iterations 200
 *   bun test/benchmarks/search-mixed-bench.js --record    # append to history
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { createReaderPools } from '../../src/storage/reader-pools.js'
import { recordBenchmark } from './history.js'

const SLO_CASES = [
  { name: 'exact-symbol', query: 'NavigationStack', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'common-symbol', query: 'View', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'broad-title', query: 'view', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'kind-filter', query: 'View', opts: { limit: 10, kind: 'symbol', noDeep: true, fuzzy: false, fast: true } },
  { name: 'framework-filter', query: 'NavigationStack', opts: { limit: 10, framework: 'swiftui', noDeep: true, fuzzy: false, fast: true } },
]

const HEAVY_CASES = [
  { name: 'typo-fuzzy', query: 'Publsher', opts: { limit: 10, noDeep: true, fuzzy: true, fast: true } },
  { name: 'body-search', query: 'privacy nutrition labels', opts: { limit: 10, noDeep: false, noEager: true, fast: true } },
]

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const iterations = parsePositiveInt(flags.iterations) ?? 100
  const warmup = parseNonNegativeInt(flags.warmup) ?? 16
  const concurrencies = parseConcurrency(flags.concurrency ?? '1,4,8,16')
  const strictSize = parsePositiveInt(flags['strict-readers']) ?? parsePositiveInt(flags.readers) ?? 4
  const deepSize = parsePositiveInt(flags['deep-readers']) ?? 2
  const ratio = parseRatio(flags.ratio ?? '4:1')
  const shouldRecord = flags.record === true

  const dbPath = resolveDbPath(flags)
  if (!existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`)

  const dataDir = dirname(dbPath)
  const logger = flags.verbose
    ? console
    : { info() {}, warn() {}, error: (...args) => console.error(...args) }

  const db = new DocsDatabase(dbPath)
  const readerPool = createReaderPools({ dbPath, strictSize, deepSize })
  await readerPool.start()
  const ctx = { db, dataDir, logger, readerPool }

  try {
    console.log('Mixed-load search benchmark')
    console.log(`  db: ${dbPath}`)
    console.log(`  rows: ${safeCount(db, 'documents').toLocaleString('en-US')}`)
    console.log(`  iterations/concurrency: ${iterations}`)
    console.log(`  warmup: ${warmup}`)
    console.log(`  readers: strict=${strictSize} deep=${deepSize}`)
    console.log(`  ratio (slo:heavy): ${ratio.slo}:${ratio.heavy}`)

    await warmup_(ctx, warmup)

    for (const concurrency of concurrencies) {
      const result = await runConcurrency({ ctx, iterations, concurrency, ratio })
      printResult(result)
      if (shouldRecord) recordResult(result, { strictSize, deepSize, ratio: `${ratio.slo}:${ratio.heavy}` })
    }
  } finally {
    try { await readerPool.close({ softDrainMs: 0 }) } catch {}
    try { db.close() } catch {}
  }
}

async function warmup_(ctx, count) {
  // Hit every distinct case at least once to warm prepared statements,
  // FTS read paths, trigram cache, and reader-thread JIT tiers.
  const all = [...SLO_CASES, ...HEAVY_CASES]
  for (let i = 0; i < count; i++) {
    const c = all[i % all.length]
    await search({ query: c.query, ...c.opts }, ctx)
  }
}

async function runConcurrency({ ctx, iterations, concurrency, ratio }) {
  const sloLat = []
  const heavyLat = []
  let sloIdx = 0
  let heavyIdx = 0
  let next = 0
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()

  async function worker() {
    while (next < iterations) {
      const index = next++
      // Pick SLO or HEAVY by the configured ratio. The modulo wraps
      // SLO_RATIO + HEAVY_RATIO slots; 0..SLO_RATIO-1 → SLO, rest → HEAVY.
      const slot = index % (ratio.slo + ratio.heavy)
      const isHeavy = slot >= ratio.slo
      const c = isHeavy
        ? HEAVY_CASES[heavyIdx++ % HEAVY_CASES.length]
        : SLO_CASES[sloIdx++ % SLO_CASES.length]
      const t0 = performance.now()
      try {
        await search({ query: c.query, ...c.opts }, ctx)
      } catch {
        // Don't pollute latency with failure cost; just count under +Inf.
      }
      const elapsed = performance.now() - t0
      if (isHeavy) heavyLat.push(elapsed)
      else sloLat.push(elapsed)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const wallMs = performance.now() - wallStart
  const cpu = process.cpuUsage(cpuStart)
  return {
    concurrency,
    iterations,
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    slo: summarize(sloLat),
    heavy: summarize(heavyLat),
  }
}

function summarize(values) {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0 }
  const sorted = values.slice().sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  }
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[idx]
}

function printResult(r) {
  console.log(`\nconcurrency=${r.concurrency} iterations=${r.iterations}`)
  console.log(`  SLO   (n=${r.slo.count}): p50=${fmt(r.slo.p50)} p95=${fmt(r.slo.p95)} p99=${fmt(r.slo.p99)} max=${fmt(r.slo.max)}`)
  console.log(`  HEAVY (n=${r.heavy.count}): p50=${fmt(r.heavy.p50)} p95=${fmt(r.heavy.p95)} p99=${fmt(r.heavy.p99)} max=${fmt(r.heavy.max)}`)
  console.log(`  wall=${fmt(r.wallMs)} cpu=${fmt(r.cpuMs)} cpu/op=${fmt(r.cpuMs / r.iterations)}`)
}

function recordResult(r, meta) {
  recordBenchmark('search-mixed-bench.jsonl', {
    concurrency: r.concurrency,
    iterations: r.iterations,
    strictSize: meta.strictSize,
    deepSize: meta.deepSize,
    ratio: meta.ratio,
    slo: r.slo,
    heavy: r.heavy,
    wallMs: r.wallMs,
    cpuMs: r.cpuMs,
  })
}

function fmt(ms) {
  return `${ms.toFixed(2)}ms`
}

function parseFlags(args) {
  const out = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('--')) continue
    const eq = a.indexOf('=')
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1)
    } else {
      const next = args[i + 1]
      if (next == null || next.startsWith('--')) {
        out[a.slice(2)] = true
      } else {
        out[a.slice(2)] = next
        i++
      }
    }
  }
  return out
}

function parsePositiveInt(value) {
  if (value == null) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

function parseNonNegativeInt(value) {
  if (value == null) return null
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function parseConcurrency(value) {
  return String(value).split(',').map(s => Number.parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0)
}

function parseRatio(value) {
  const [slo, heavy] = String(value).split(':').map(s => Number.parseInt(s.trim(), 10))
  if (!Number.isFinite(slo) || slo < 0 || !Number.isFinite(heavy) || heavy < 0 || (slo + heavy === 0)) {
    throw new Error(`--ratio must be "<slo>:<heavy>" with non-negative integers, got ${value}`)
  }
  return { slo, heavy }
}

function resolveDbPath(flags) {
  if (typeof flags.db === 'string') return resolve(flags.db)
  return resolve(homedir(), '.apple-docs', 'apple-docs.db')
}

function safeCount(db, table) {
  try {
    return db.db.query(`SELECT COUNT(*) AS c FROM ${table}`).get().c
  } catch {
    return 0
  }
}

await main()
