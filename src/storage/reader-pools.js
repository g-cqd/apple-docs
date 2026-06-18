// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Split reader-pool factory.
 *
 * Creates two `createReaderPool` instances behind a unified facade:
 *   - `strict`  — FTS / trigram / exact / title-prefix lookups. Sized
 *                 close to `availableParallelism() - 4` (cap 12).
 *   - `deep`    — fuzzy-title + body FTS. Smaller (cap 4); shorter
 *                 default deadline. Operators run multi-second deep
 *                 work without hijacking the strict workers.
 *
 * The returned object satisfies the same surface as a single
 * `createReaderPool(...)` (`run`, `start`, `close`, `recycle`,
 * `stats`, `dbPath`), so existing call sites that consume
 * `ctx.readerPool` keep working unchanged. `run()` looks up the
 * classifier (`reader-pool-classifier.js`) and dispatches to the
 * matching pool.
 *
 * Per-pool stats are exposed via `stats().pools` for the metrics
 * provider; the top-level fields (size/active/pending/...) are the
 * sum across both pools so dashboards that don't care about the
 * split see the same totals as before.
 */

import { availableParallelism } from 'node:os'
import { createReaderPool } from './reader-pool.js'
import { classifyOp } from './reader-pool-classifier.js'

const STRICT_DEFAULT_DEADLINE_MS = 5_000
const DEEP_DEFAULT_DEADLINE_MS = 2_500
const DEEP_MAX_WORKERS = 4
const STRICT_MAX_WORKERS = 12
const FALLBACK_HW = 6

function resolveStrictSize(opts) {
  if (opts.strictSize) return Math.max(1, opts.strictSize)
  const hw = availableParallelism?.() ?? FALLBACK_HW
  // Reserve cores for main thread, OS, AND the deep pool. Leave at
  // least 2 cores headroom; cap at STRICT_MAX_WORKERS.
  return Math.min(STRICT_MAX_WORKERS, Math.max(2, hw - 4))
}

function resolveDeepSize(opts) {
  if (opts.deepSize) return Math.max(1, opts.deepSize)
  const hw = availableParallelism?.() ?? FALLBACK_HW
  // Quarter of available parallelism, capped at DEEP_MAX_WORKERS.
  // Floor at 1 so even single-core hosts get one deep worker.
  return Math.min(DEEP_MAX_WORKERS, Math.max(1, Math.floor(hw / 4)))
}

/**
 * @param {{
 *   dbPath: string,
 *   strictSize?: number,
 *   deepSize?: number,
 *   strictDeadlineMs?: number,
 *   deepDeadlineMs?: number,
 *   maxPendingPerWorker?: number,
 *   log?: (level: string, msg: string) => void,
 *   WorkerCtor?: any,
 * }} opts
 */
export function createReaderPools(opts = {}) {
  const log = opts.log
  const strictSize = resolveStrictSize(opts)
  const deepSize = resolveDeepSize(opts)
  const strict = createReaderPool({
    dbPath: opts.dbPath,
    size: strictSize,
    deadlineMs: opts.strictDeadlineMs ?? STRICT_DEFAULT_DEADLINE_MS,
    maxPendingPerWorker: opts.maxPendingPerWorker,
    log: log ? (lvl, msg) => log(lvl, `strict: ${msg}`) : undefined,
    WorkerCtor: opts.strictWorkerCtor ?? opts.WorkerCtor,
  })
  const deep = createReaderPool({
    dbPath: opts.dbPath,
    size: deepSize,
    deadlineMs: opts.deepDeadlineMs ?? DEEP_DEFAULT_DEADLINE_MS,
    maxPendingPerWorker: opts.maxPendingPerWorker,
    log: log ? (lvl, msg) => log(lvl, `deep: ${msg}`) : undefined,
    WorkerCtor: opts.deepWorkerCtor ?? opts.WorkerCtor,
  })

  async function start() {
    // Boot the pools SERIALLY. Each pool already serializes its own worker
    // boots to dodge the WAL/SHM bring-up race on `PRAGMA journal_mode =
    // WAL`; starting both at once reintroduced that race ACROSS pools — a
    // worker in one pool hitting SQLITE_NOTADB while the other pool's worker
    // brought up the shared -wal/-shm, which rejected the whole start and
    // disabled both pools. Serial start keeps total boot latency at
    // (strict + deep) × ~10-30ms — negligible against process lifetime.
    await strict.start()
    await deep.start()
  }

  async function run(op, args = [], runOpts = {}) {
    const target = classifyOp(op) === 'deep' ? deep : strict
    return target.run(op, args, runOpts)
  }

  async function close(closeOpts = {}) {
    await Promise.all([strict.close(closeOpts), deep.close(closeOpts)])
  }

  async function recycle() {
    await Promise.all([strict.recycle(), deep.recycle()])
  }

  function stats() {
    const s = strict.stats()
    const d = deep.stats()
    return {
      // Aggregate (matches the old single-pool shape so existing
      // /healthz consumers keep working).
      size: s.size + d.size,
      active: s.active + d.active,
      pending: s.pending + d.pending,
      spawns: s.spawns + d.spawns,
      errors: s.errors + d.errors,
      timeouts: s.timeouts + d.timeouts,
      backpressureRejects: s.backpressureRejects + d.backpressureRejects,
      // Per-pool detail for label-aware metrics.
      pools: { strict: s, deep: d },
    }
  }

  return {
    start,
    run,
    close,
    recycle,
    stats,
    dbPath: opts.dbPath,
    // Test-only handles.
    _strict: strict,
    _deep: deep,
  }
}
