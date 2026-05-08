import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { createReaderPool } from '../../src/storage/reader-pool.js'
import { startDevServer } from '../../src/web/serve.js'
import { recordBenchmark } from './history.js'

/**
 * Real-corpus search benchmark.
 *
 * Usage:
 *   bun test/benchmarks/search-real-bench.js --mode api --concurrency 1,2,4,8,16 --iterations 200 --readers 4
 *   bun test/benchmarks/search-real-bench.js --mode direct --db ~/.apple-docs/apple-docs.db --readers 4
 */

const DEFAULT_CASES = [
  { name: 'exact-symbol', query: 'NavigationStack', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'common-symbol', query: 'View', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'broad-title', query: 'view', opts: { limit: 10, noDeep: true, fuzzy: false, fast: true } },
  { name: 'kind-filter', query: 'View', opts: { limit: 10, kind: 'symbol', noDeep: true, fuzzy: false, fast: true } },
  { name: 'framework-filter', query: 'NavigationStack', opts: { limit: 10, framework: 'swiftui', noDeep: true, fuzzy: false, fast: true } },
]

const FUZZY_CASES = [
  { name: 'typo-fuzzy', query: 'Publsher', slo: false, opts: { limit: 10, noDeep: true, fuzzy: true, fast: true } },
]

const BODY_CASES = [
  { name: 'body-full-text', query: 'privacy nutrition labels', slo: false, opts: { limit: 10, noDeep: false, noEager: true, fast: true } },
]

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  const dbPath = resolveDbPath(flags)
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`)
  }

  const mode = flags.mode ?? 'api'
  if (!['api', 'direct'].includes(mode)) {
    throw new Error(`--mode must be "api" or "direct", got ${mode}`)
  }
  const iterations = parsePositiveInt(flags.iterations) ?? 200
  const warmup = parseNonNegativeInt(flags.warmup) ?? 24
  const concurrencies = parseConcurrency(flags.concurrency ?? '1,2,4,8,16')
  const readers = flags.readers === 'off' ? 0 : parsePositiveInt(flags.readers)
  const shouldRecord = flags.record === true
  const includeBody = flags['include-body'] === true
  const includeFuzzy = flags['include-fuzzy'] === true
  const cacheMode = flags.cache ?? 'on'
  const cases = [
    ...DEFAULT_CASES,
    ...(includeFuzzy ? FUZZY_CASES : []),
    ...(includeBody ? BODY_CASES : []),
  ]

  const db = new DocsDatabase(dbPath)
  let readerPool = null
  let serverInfo = null
  let runner

  const logger = flags.verbose
    ? console
    : { info() {}, warn() {}, error: (...args) => console.error(...args) }
  const ctx = { db, dataDir: dirnameOfDb(dbPath), logger }

  try {
    if (mode === 'api') {
      if (cacheMode === 'off') process.env.APPLE_DOCS_WEB_SEARCH_CACHE = '0'
      if (readers === 0) process.env.APPLE_DOCS_WEB_READERS = 'off'
      else if (readers != null) process.env.APPLE_DOCS_WEB_READER_WORKERS = String(readers)
      serverInfo = await startDevServer({ port: 0 }, ctx)
      runner = createApiRunner(serverInfo.url)
    } else {
      if (readers && readers > 0) {
        readerPool = createReaderPool({ dbPath, size: readers })
        await readerPool.start()
      }
      runner = createDirectRunner({ ...ctx, ...(readerPool ? { readerPool } : {}) })
    }

    console.log(`Real corpus search benchmark`)
    console.log(`  mode: ${mode}`)
    console.log(`  db: ${dbPath}`)
    console.log(`  rows: ${safeCount(db, 'documents').toLocaleString('en-US')}`)
    console.log(`  iterations/concurrency: ${iterations}`)
    console.log(`  warmup: ${warmup}`)
    console.log(`  readers: ${readers == null ? 'auto' : readers}`)
    console.log(`  api cache: ${cacheMode}`)
    console.log(`  fuzzy cases: ${includeFuzzy ? 'included as non-SLO' : 'excluded from default SLO run'}`)
    console.log(`  body cases: ${includeBody ? 'included' : 'excluded from default SLO run'}`)

    await warmupRunner(runner, cases, warmup)

    for (const concurrency of concurrencies) {
      const result = await runConcurrency({ runner, cases, iterations, concurrency })
      printResult(result)
      if (shouldRecord) recordResult(result, { mode, readers: readers ?? 'auto', includeBody })
    }
  } finally {
    try { await serverInfo?.close?.() } catch {}
    try { await readerPool?.close?.() } catch {}
    try { db.close() } catch {}
  }
}

function createDirectRunner(ctx) {
  return async (benchCase) => {
    const result = await search({ query: benchCase.query, ...benchCase.opts }, ctx)
    return {
      cache: 'n/a',
      paths: result.results?.slice(0, 5).map(r => r.path) ?? [],
    }
  }
}

function createApiRunner(baseUrl) {
  return async (benchCase) => {
    const url = new URL('/api/search', baseUrl)
    appendSearchParams(url.searchParams, benchCase)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
    const payload = await response.json()
    return {
      cache: response.headers.get('x-apple-docs-cache') ?? 'n/a',
      paths: payload.results?.slice(0, 5).map(r => r.path) ?? [],
    }
  }
}

function appendSearchParams(params, benchCase) {
  params.set('q', benchCase.query)
  const opts = benchCase.opts ?? {}
  for (const [key, value] of Object.entries(opts)) {
    if (value == null) continue
    if (key === 'noDeep') {
      if (value === true) params.set('no_deep', '1')
      else params.set('deep', '1')
      continue
    }
    if (key === 'noEager') {
      if (value === true) params.set('no_eager', '1')
      continue
    }
    if (key === 'fuzzy') {
      if (value === true) params.set('fuzzy', '1')
      if (value === false) params.set('no_fuzzy', '1')
      continue
    }
    if (key === 'fast') {
      if (value === false) params.set('exhaustive', '1')
      continue
    }
    if (value === false) continue
    params.set(toSnake(key), String(value))
  }
}

async function warmupRunner(runner, cases, count) {
  for (let i = 0; i < count; i++) {
    await runner(cases[i % cases.length])
  }
}

async function runConcurrency({ runner, cases, iterations, concurrency }) {
  let next = 0
  const latencies = []
  const sloLatencies = []
  const caseStats = new Map()
  const cache = { hit: 0, miss: 0, other: 0 }
  const cpuStart = process.cpuUsage()
  const wallStart = performance.now()

  async function worker() {
    while (next < iterations) {
      const index = next++
      const benchCase = cases[index % cases.length]
      const started = performance.now()
      const result = await runner(benchCase)
      const elapsed = performance.now() - started
      latencies.push(elapsed)
      if (benchCase.slo !== false) sloLatencies.push(elapsed)
      addCaseStat(caseStats, benchCase, elapsed, result.paths)
      if (result.cache === 'hit') cache.hit++
      else if (result.cache === 'miss') cache.miss++
      else cache.other++
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
    all: summarize(latencies),
    slo: summarize(sloLatencies),
    cache,
    cases: [...caseStats.values()].map(finalizeCaseStat),
  }
}

function addCaseStat(caseStats, benchCase, elapsed, paths) {
  let entry = caseStats.get(benchCase.name)
  if (!entry) {
    entry = { name: benchCase.name, slo: benchCase.slo !== false, latencies: [], samplePaths: paths }
    caseStats.set(benchCase.name, entry)
  }
  entry.latencies.push(elapsed)
  if (entry.samplePaths.length === 0 && paths.length > 0) entry.samplePaths = paths
}

function finalizeCaseStat(entry) {
  return {
    name: entry.name,
    slo: entry.slo,
    ...summarize(entry.latencies),
    samplePaths: entry.samplePaths,
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
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[index]
}

function printResult(result) {
  const cacheTotal = result.cache.hit + result.cache.miss
  const hitRate = cacheTotal > 0 ? result.cache.hit / cacheTotal : 0
  console.log(`\nconcurrency=${result.concurrency} iterations=${result.iterations}`)
  console.log(`  SLO cases: p50=${fmt(result.slo.p50)} p95=${fmt(result.slo.p95)} p99=${fmt(result.slo.p99)} max=${fmt(result.slo.max)} target_p95=25.00ms`)
  console.log(`  all cases: p50=${fmt(result.all.p50)} p95=${fmt(result.all.p95)} p99=${fmt(result.all.p99)} max=${fmt(result.all.max)}`)
  console.log(`  wall=${fmt(result.wallMs)} cpu=${fmt(result.cpuMs)} avg_cpu/op=${fmt(result.cpuMs / result.iterations)} cache_hit_rate=${(hitRate * 100).toFixed(1)}%`)
  for (const entry of result.cases) {
    console.log(`  case ${entry.name}${entry.slo ? '' : ' (non-SLO)'}: p95=${fmt(entry.p95)} top=${entry.samplePaths[0] ?? '-'}`)
  }
}

function recordResult(result, meta) {
  recordBenchmark('search-real-slo-p95', {
    value: result.slo.p95,
    unit: 'ms',
    concurrency: result.concurrency,
    ...meta,
  })
  recordBenchmark('search-real-all-p95', {
    value: result.all.p95,
    unit: 'ms',
    concurrency: result.concurrency,
    ...meta,
  })
}

function parseFlags(args) {
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return flags
}

function resolveDbPath(flags) {
  if (flags.db) return resolveTilde(flags.db)
  const home = flags.home ? resolveTilde(flags.home) : resolveTilde(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'))
  return join(home, 'apple-docs.db')
}

function dirnameOfDb(dbPath) {
  return dbPath.endsWith('/apple-docs.db') ? dbPath.slice(0, -'/apple-docs.db'.length) : resolve(dbPath, '..')
}

function parseConcurrency(value) {
  return String(value)
    .split(',')
    .map(part => parsePositiveInt(part.trim()))
    .filter(Boolean)
}

function parsePositiveInt(value) {
  if (value == null) return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseNonNegativeInt(value) {
  if (value == null) return null
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function resolveTilde(path) {
  const text = String(path)
  return text === '~' || text.startsWith('~/') ? join(homedir(), text.slice(2)) : resolve(text)
}

function safeCount(db, table) {
  try { return db.db.query(`SELECT COUNT(*) as count FROM ${table}`).get().count } catch { return 0 }
}

function toSnake(value) {
  return value.replace(/[A-Z]/g, match => `_${match.toLowerCase()}`)
}

function fmt(value) {
  return `${value.toFixed(2)}ms`
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? err)
  process.exit(1)
})
