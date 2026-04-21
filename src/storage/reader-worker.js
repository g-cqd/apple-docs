import { parentPort, workerData } from 'node:worker_threads'
import { DocsDatabase } from './database.js'

// Whitelist of read-only methods the pool is allowed to invoke. The worker
// refuses anything outside this set so a malformed pool message can never
// accidentally route a write through the reader handle. Writers still use
// the main-thread handle; workers are strictly readers.
const READ_OPS = new Set([
  'searchPages',
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

if (!parentPort) {
  throw new Error('reader-worker.js must be run as a worker thread')
}

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
  if (msg.type === 'close') {
    try { db?.close?.() } catch {}
    process.exit(0)
    return
  }
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
