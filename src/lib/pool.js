/**
 * Run async tasks with bounded concurrency.
 * Starts up to `limit` tasks in parallel. When one finishes, starts the next.
 *
 * @param {T[]} items - Items to process
 * @param {number} limit - Max concurrent tasks
 * @param {(item: T) => Promise<void>} fn - Async processor
 * @returns {Promise<void>}
 * @template T
 */
export function pool(items, limit, fn) {
  const queue = [...items]
  const active = new Set()
  const errors = []

  return new Promise((resolve, reject) => {
    function drain() {
      while (active.size < limit && queue.length > 0) {
        const item = queue.shift()
        const promise = fn(item)
          .catch(err => { errors.push(err) })
          .finally(() => {
            active.delete(promise)
            drain()
          })
        active.add(promise)
      }
      if (active.size === 0 && queue.length === 0) {
        if (errors.length > 0) {
          reject(errors.length === 1 ? errors[0] : new AggregateError(errors, `${errors.length} tasks failed`))
        } else {
          resolve()
        }
      }
    }
    drain()
  })
}
