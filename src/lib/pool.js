/**
 * Run async tasks with bounded concurrency.
 * Starts up to `limit` tasks in parallel. When one finishes, starts the next.
 *
 * Implementation note: dispatch walks `items` with an index cursor rather
 * than copying into a queue and `shift()`-ing the front. `Array.shift()`
 * is O(n) per call (V8/JSC reindex the backing storage), so the previous
 * `[...items]` + `queue.shift()` form spent O(n²) just managing the
 * dispatch list on a 345k-document build. Index walk is O(1) per dequeue
 * and avoids the upfront copy.
 *
 * P2.8: optional `signal` aborts further task starts. In-flight tasks are
 * not killed (the supplied fn() owns its own cancellation) but no new
 * tasks are pulled from `items` once aborted, and the returned Promise
 * rejects with the abort reason once in-flight work settles.
 *
 * @param {T[]} items - Items to process
 * @param {number} limit - Max concurrent tasks
 * @param {(item: T, opts: { signal?: AbortSignal }) => Promise<void>} fn - Async processor
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<void>}
 * @template T
 */
export function pool(items, limit, fn, opts = {}) {
  const signal = opts.signal
  const length = items.length
  let cursor = 0
  const active = new Set()
  const errors = []

  return new Promise((resolve, reject) => {
    function settle() {
      if (active.size > 0 || cursor < length) return
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
        return
      }
      if (errors.length > 0) {
        reject(errors.length === 1 ? errors[0] : new AggregateError(errors, `${errors.length} tasks failed`))
      } else {
        resolve()
      }
    }
    function drain() {
      if (signal?.aborted) {
        // Stop pulling new items; let active settle naturally.
        cursor = length
        settle()
        return
      }
      while (active.size < limit && cursor < length) {
        const item = items[cursor++]
        const promise = Promise.resolve()
          .then(() => fn(item, { signal }))
          .catch(err => { errors.push(err) })
          .finally(() => {
            active.delete(promise)
            drain()
          })
        active.add(promise)
      }
      settle()
    }
    if (signal) signal.addEventListener('abort', drain, { once: true })
    drain()
  })
}
