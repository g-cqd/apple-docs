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

  return new Promise((resolve) => {
    function drain() {
      while (active.size < limit && queue.length > 0) {
        const item = queue.shift()
        const promise = fn(item).finally(() => {
          active.delete(promise)
          drain()
        })
        active.add(promise)
      }
      if (active.size === 0 && queue.length === 0) {
        resolve()
      }
    }
    drain()
  })
}
