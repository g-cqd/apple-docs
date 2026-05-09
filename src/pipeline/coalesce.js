/**
 * Per-key promise coalescer for on-demand fetch+persist paths.
 *
 * When a cold request for a key arrives concurrently from multiple HTTP
 * connections, naively each handler would issue its own upstream fetch and
 * race to upsert the same row. Coalescing dedupes them onto a single
 * in-flight promise so the upstream sees one request and the DB sees one
 * write per key per "miss event".
 *
 * The map is module-local: a single web process serves the on-demand path,
 * and it's already protected from concurrent processes by the SQLite
 * UPSERT in persistFetchedDocPage. This is a pure latency/cost optimization,
 * not a correctness primitive.
 */

const inflight = new Map()

/**
 * Run `fn()` exactly once per `key` while a prior call is still pending.
 * Concurrent callers receive the same promise; resolution clears the entry.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function coalesceByKey(key, fn) {
  const existing = inflight.get(key)
  if (existing) return existing
  const promise = Promise.resolve()
    .then(fn)
    .finally(() => {
      // Only delete if the entry still points at *this* promise — guards
      // against the unlikely case of a synchronous re-coalesce inside fn.
      if (inflight.get(key) === promise) inflight.delete(key)
    })
  inflight.set(key, promise)
  return promise
}

/** Test-only: clear all in-flight entries. */
export function _resetCoalesceForTests() {
  inflight.clear()
}

/** Test-only: report how many keys are currently in flight. */
export function _coalesceInflightCount() {
  return inflight.size
}
