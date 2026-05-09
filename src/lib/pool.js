/**
 * Run async tasks with bounded concurrency.
 * Starts up to `limit` tasks in parallel. When one finishes, starts the next.
 *
 * P2.8: optional `signal` aborts further task starts. In-flight tasks are
 * not killed (the supplied fn() owns its own cancellation) but no new
 * tasks are pulled from the queue once aborted, and the returned Promise
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
  const queue = [...items]
  const active = new Set()
  const errors = []

  return new Promise((resolve, reject) => {
    function settle() {
      if (active.size > 0 || queue.length > 0) return
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
        // Drop queued items; let active settle naturally.
        queue.length = 0
        settle()
        return
      }
      while (active.size < limit && queue.length > 0) {
        const item = queue.shift()
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
