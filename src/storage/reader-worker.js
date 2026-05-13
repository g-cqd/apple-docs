import { parentPort, workerData } from 'node:worker_threads'
import { DocsDatabase } from './database.js'

/**
 * Whitelist of read-only methods the pool is allowed to invoke. Exported
 * so the parent-thread pool can reject doomed ops synchronously without
 * paying a worker round-trip — important because the worker round-trip
 * is bounded by `deadlineMs` and, on slow CI runners (Stryker @ 8×
 * concurrency on a 4-vCPU Ubuntu box), a queued doomed op can blow
 * past the deadline before the worker gets CPU time to respond, masking
 * the real "not in whitelist" error behind a generic timeout error.
 *
 * The worker still independently re-checks this list as defense in
 * depth — a malformed message that bypasses the parent check (e.g.
 * a future bug in postMessage) must not route a write through the
 * reader handle.
 */
export const READ_OPS = new Set([
  'searchPages',
  'searchTitleExact',
  'searchTrigram',
  'searchBody',
  'getDocumentSections',
  'getSearchRecordById',
  'getBodyIndexCount',
  'getPage',
  'searchByTitle',
  'getTier',
  'getSchemaVersion',
  // CPU-bound title matching. Cost dominated by Levenshtein over the trigram
  // pre-filter bucket; routing it through a worker lets it overlap with the
  // FTS/trigram tiers rather than tail-appending to them on the main thread.
  'fuzzyMatchTitles',
])

// Top-level worker bootstrap is guarded by `parentPort` so this module
// can also be imported by reader-pool.js on the main thread (which
// pulls READ_OPS and otherwise has no business running the worker
// startup path). Inside an actual worker_threads thread, parentPort
// is non-null and the block executes.
if (parentPort) {
  // `workerData` carries the DB path chosen by the pool manager. Each worker
  // opens its own `bun:sqlite` handle and runs the same PRAGMA block as the
  // main-thread writer; WAL permits unlimited concurrent readers against the
  // same file.
  const { dbPath } = workerData ?? {}
  if (!dbPath) {
    parentPort.postMessage({ type: 'fatal', error: { message: 'worker spawned without dbPath' } })
    process.exit(1)
  }

  let db
  try {
    db = new DocsDatabase(dbPath)
  } catch (err) {
    parentPort.postMessage({
      type: 'fatal',
      error: { message: err?.message ?? String(err), stack: err?.stack },
    })
    process.exit(1)
  }

  // Signal readiness so the pool can start dispatching. Without this the pool
  // would race the DB open and send work to a half-initialized worker.
  parentPort.postMessage({ type: 'ready' })

  parentPort.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return
    if (msg.type !== 'call') return
    const { id, op, args } = msg
    if (!READ_OPS.has(op)) {
      parentPort.postMessage({
        type: 'result',
        id,
        ok: false,
        error: { message: `reader-worker: operation not in whitelist: ${op}` },
      })
      return
    }
    const fn = db[op]
    if (typeof fn !== 'function') {
      parentPort.postMessage({
        type: 'result',
        id,
        ok: false,
        error: { message: `reader-worker: DocsDatabase has no method ${op}` },
      })
      return
    }
    try {
      const data = fn.apply(db, Array.isArray(args) ? args : [])
      parentPort.postMessage({ type: 'result', id, ok: true, data })
    } catch (err) {
      parentPort.postMessage({
        type: 'result',
        id,
        ok: false,
        error: { message: err?.message ?? String(err), stack: err?.stack },
      })
    }
  })
}
