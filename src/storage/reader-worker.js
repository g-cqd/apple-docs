// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { parentPort, workerData } from 'node:worker_threads'
import { getNativeLib, isNativeEnabled } from '../native/loader.js'
import { DocsDatabase } from './database.js'
import { nativeSearchPages, nativeStorageOpen } from './storage-native.js'

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
  'getSearchRecordsByIds',
  'getBodyIndexCount',
  'hasBodyIndex',
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

  // RFC 0001 P5 first slice: open a native (libsqlite3 via bun:ffi) read
  // handle for the searchPages path. Returns null unless `APPLE_DOCS_NATIVE`
  // explicitly names `storage` AND the dylib + FTS5 are present, in which
  // case searchPages keeps using bun:sqlite. Opened inside the pool's SERIAL
  // boot so it inherits the WAL/SHM open-race fix. Read-only; the bun:sqlite
  // writer is untouched. Not closed on terminate() — same lifecycle as the
  // bun:sqlite reader handle above (both die with the process).
  let storageHandle = null
  try {
    storageHandle = nativeStorageOpen(dbPath)
  } catch {
    storageHandle = null
  }

  // Signal readiness so the pool can start dispatching. Without this the pool
  // would race the DB open and send work to a half-initialized worker.
  // Native provenance rides along: announce lines logged INSIDE the worker go
  // to a stderr nobody routes, so the pool logs one parent-process line
  // instead (visible in launchd service logs).
  let native = []
  try {
    const enabled = ['fusion', 'archive', 'embed'].filter((m) => isNativeEnabled(m))
    if (enabled.length > 0 && getNativeLib()) native = enabled
    if (storageHandle != null) native = [...native, 'storage']
  } catch {
    // provenance is informational — never block readiness
  }
  parentPort.postMessage({ type: 'ready', native })

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
      const callArgs = Array.isArray(args) ? args : []
      let data
      if (op === 'searchPages' && storageHandle != null) {
        // Native attempt; null → fall through to bun:sqlite for this call.
        data = nativeSearchPages(storageHandle, ...callArgs)
        if (data === null) data = fn.apply(db, callArgs)
      } else {
        data = fn.apply(db, callArgs)
      }
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
