import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { availableParallelism } from 'node:os'

const WORKER_URL = new URL('./reader-worker.js', import.meta.url)

const DEFAULT_MAX_WORKERS = 12
const FALLBACK_SIZE = 6

function resolveDefaultSize() {
  try {
    const hw = availableParallelism?.() ?? FALLBACK_SIZE
    // Leave headroom for the main thread + OS. Cap at DEFAULT_MAX_WORKERS so
    // a 96-core host doesn't spawn absurd numbers of SQLite handles.
    return Math.min(DEFAULT_MAX_WORKERS, Math.max(2, hw - 2))
  } catch {
    return FALLBACK_SIZE
  }
}

/**
 * Spawns a pool of worker threads each holding its own `bun:sqlite` read-only
 * handle against `dbPath`. Routes read-only DocsDatabase method calls to the
 * least-loaded worker so heavy SQL work actually parallelizes instead of
 * serializing on the Bun event loop.
 *
 * API:
 *   - `run(op, args)` → Promise resolving to the method's return value.
 *   - `close()` → terminate all workers; rejects any in-flight requests.
 *   - `recycle()` → close all workers and respawn; used after `apple-docs
 *     update` so stale prepared statements / schema assumptions reload.
 *   - `stats()` → `{ size, active, pending, spawns, errors }`.
 *
 * Design notes:
 *   - Dispatch picks the worker with the fewest pending requests. O(N) per
 *     call; trivial for N ≤ 12.
 *   - Every worker's `pending` map is drained on crash: all promises reject
 *     with the exit reason and the worker respawns on next `run()`.
 *   - Worker startup is asynchronous but the pool returns from `start()`
 *     only after every worker emits `{type:'ready'}`. Avoids racing the
 *     DB open on the first dispatch.
 *   - Readers are optional: if the pool is never instantiated, commands
 *     call `ctx.db.*` directly on the main thread as before.
 *
 * @param {object} opts
 * @param {string} opts.dbPath - Filesystem path to the SQLite database.
 *   `:memory:` is not supported (it wouldn't survive the process boundary).
 * @param {number} [opts.size] - Number of workers. Defaults to a hardware-
 *   aware sizing (`availableParallelism() - 2`, capped at 12).
 * @param {(level: 'info'|'warn'|'error', msg: string) => void} [opts.log]
 * @param {new (...args: any[]) => Worker} [opts.WorkerCtor] - Injectable
 *   for tests.
 */
export function createReaderPool(opts = {}) {
  const { dbPath, log } = opts
  if (!dbPath || dbPath === ':memory:') {
    throw new Error(`createReaderPool: dbPath must be a real file path, got ${String(dbPath)}`)
  }
  const size = Math.max(1, opts.size ?? resolveDefaultSize())
  const WorkerCtor = opts.WorkerCtor ?? Worker

  const stats = { spawns: 0, errors: 0 }

  // Each entry: { worker, pending: Map<id, {resolve,reject}>, ready: Promise,
  // readyResolve, alive: bool }
  const slots = new Array(size).fill(null)
  let idCounter = 1
  let closed = false

  function spawn(index) {
    const slot = {
      worker: null,
      pending: new Map(),
      ready: null,
      readyResolve: null,
      readyReject: null,
      alive: true,
    }
    slot.ready = new Promise((resolve, reject) => {
      slot.readyResolve = resolve
      slot.readyReject = reject
    })
    const worker = new WorkerCtor(fileURLToPath(WORKER_URL), { workerData: { dbPath } })
    slot.worker = worker
    stats.spawns++

    worker.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ready') {
        slot.readyResolve?.()
        return
      }
      if (msg.type === 'fatal') {
        const err = new Error(`reader-worker fatal: ${msg.error?.message ?? 'unknown'}`)
        slot.readyReject?.(err)
        failSlot(index, err)
        return
      }
      if (msg.type !== 'result') return
      const entry = slot.pending.get(msg.id)
      if (!entry) return
      slot.pending.delete(msg.id)
      if (msg.ok) entry.resolve(msg.data)
      else entry.reject(rebuildError(msg.error))
    })

    worker.on('error', (err) => {
      stats.errors++
      log?.('error', `reader-worker[${index}] error: ${err?.message ?? err}`)
      slot.readyReject?.(err)
      failSlot(index, err)
    })

    worker.on('exit', (code) => {
      if (!slot.alive) return // expected shutdown
      slot.alive = false
      const err = new Error(`reader-worker[${index}] exited with code ${code}`)
      stats.errors++
      log?.('warn', err.message)
      slot.readyReject?.(err)
      failSlot(index, err)
    })

    slots[index] = slot
  }

  function failSlot(index, err) {
    const slot = slots[index]
    if (!slot) return
    slot.alive = false
    for (const entry of slot.pending.values()) entry.reject(err)
    slot.pending.clear()
    slots[index] = null
    // Spawn lazily on next dispatch instead of eagerly, so a runaway error
    // loop doesn't thrash. Next `run()` will respawn this index.
  }

  async function start() {
    // Spawn serially: N workers opening the same SQLite file simultaneously
    // races on WAL / SHM bring-up on some platforms (observed on x86 Darwin:
    // "database disk image is malformed" / "malformed sqlite_master" fatals
    // at worker boot). The cost is one-time startup latency on the order of
    // N × ~10-30ms; trivial against process lifetime, eliminates the race.
    for (let i = 0; i < size; i++) {
      spawn(i)
      const slot = slots[i]
      if (slot?.ready) await slot.ready
    }
  }

  function pickSlot() {
    let best = -1
    let bestLoad = Number.POSITIVE_INFINITY
    for (let i = 0; i < size; i++) {
      let slot = slots[i]
      if (!slot || !slot.alive) {
        spawn(i)
        slot = slots[i]
      }
      const load = slot.pending.size
      if (load < bestLoad) {
        best = i
        bestLoad = load
        if (load === 0) break // can't do better than zero
      }
    }
    return best
  }

  async function run(op, args = []) {
    if (closed) throw new Error('reader-pool: run() after close()')
    const idx = pickSlot()
    if (idx < 0) throw new Error('reader-pool: no workers available')
    const slot = slots[idx]
    // Wait for this particular worker to emit ready. Already-ready slots
    // resolve immediately; newly-spawned ones (after failSlot) block until
    // the DB handle opens. A rejection here means spawn failed; let it
    // propagate to the caller.
    await slot.ready
    const id = idCounter++
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject })
      try {
        slot.worker.postMessage({ type: 'call', id, op, args })
      } catch (err) {
        slot.pending.delete(id)
        reject(err)
      }
    })
  }

  async function close() {
    if (closed) return
    closed = true
    // Use `terminate()` exclusively — the one-shot way to reap a worker in both
    // Node and Bun. Earlier revisions also posted a `{type:'close'}` message so
    // the worker could `db.close(); process.exit(0)` itself, but that races
    // with `terminate()` (both paths tear down the thread simultaneously) and
    // produced a `workers_spawned != workers_terminated` leak on Bun 1.3.13,
    // which segfaulted during test-harness shutdown. Read-only SQLite handles
    // don't need graceful flushing; the OS reclaims them when the worker dies.
    const promises = []
    for (let i = 0; i < size; i++) {
      const slot = slots[i]
      if (!slot) continue
      for (const entry of slot.pending.values()) {
        entry.reject(new Error('reader-pool: closed'))
      }
      slot.pending.clear()
      slot.alive = false
      promises.push(slot.worker.terminate?.() ?? Promise.resolve())
      slots[i] = null
    }
    await Promise.all(promises)
  }

  async function recycle() {
    if (closed) return
    // Close every slot and respawn. Spawn happens eagerly so the caller sees
    // the post-recycle pool already warm. Same `terminate()`-only rationale as
    // `close()` — no `postMessage({type:'close'})` race with the worker's own
    // `process.exit(0)`.
    const oldSlots = slots.slice()
    for (let i = 0; i < size; i++) slots[i] = null
    for (const slot of oldSlots) {
      if (!slot) continue
      for (const entry of slot.pending.values()) {
        entry.reject(new Error('reader-pool: recycling'))
      }
      slot.pending.clear()
      slot.alive = false
      try { await slot.worker.terminate?.() } catch {}
    }
    for (let i = 0; i < size; i++) spawn(i)
    await Promise.all(slots.map((s) => s?.ready).filter(Boolean))
  }

  function statsSnapshot() {
    let active = 0
    let pending = 0
    for (const slot of slots) {
      if (!slot) continue
      if (slot.alive) active++
      pending += slot.pending.size
    }
    return { size, active, pending, spawns: stats.spawns, errors: stats.errors }
  }

  return {
    start,
    run,
    close,
    recycle,
    stats: statsSnapshot,
    // Expose dbPath for diagnostics and for tests.
    dbPath,
  }
}

function rebuildError(raw) {
  const err = new Error(raw?.message ?? 'reader-worker: unknown error')
  if (raw?.stack) err.stack = raw.stack
  return err
}

// Export for test harnesses that need the resolved default size without
// spawning a pool.
export function __defaultReaderPoolSize() {
  return resolveDefaultSize()
}

/**
 * Thin routing helper: when `ctx.readerPool` is present, dispatches `op` to a
 * worker; otherwise calls `ctx.db[op](...args)` directly. Always returns a
 * Promise so callsites have a uniform `await` shape regardless of whether
 * the pool is enabled.
 *
 * Intentionally minimal — it exists so command modules don't need to know
 * about the pool's existence beyond whether to `await`.
 */
export async function runRead(ctx, op, args = []) {
  if (ctx?.readerPool) return ctx.readerPool.run(op, args)
  const fn = ctx?.db?.[op]
  if (typeof fn !== 'function') {
    throw new Error(`runRead: ctx.db has no method ${op}`)
  }
  return fn.apply(ctx.db, args)
}
