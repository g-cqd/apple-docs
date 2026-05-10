/**
 * Counting semaphore for bounding global concurrency.
 * All parallel roots share one semaphore so total in-flight fetches are capped.
 *
 * `acquire({ signal })` and `run(fn, { signal })` accept an optional
 * caller AbortSignal. If the signal aborts while the caller is queued,
 * the queued waiter is rejected with the abort reason and removed from
 * the queue (no permit leak). A signal already aborted at acquire-time
 * also rejects immediately.
 */
export class BackpressureError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BackpressureError'
  }
}

export class Semaphore {
  constructor(max, opts = {}) {
    this.max = max
    this.maxWaiters = opts.maxWaiters ?? null
    this.active = 0
    this._queue = []
  }

  async acquire(opts = {}) {
    const signal = opts.signal
    if (signal?.aborted) throw signal.reason ?? new DOMException('aborted', 'AbortError')

    if (this.active < this.max) {
      this.active++
      return
    }

    if (this.maxWaiters != null && this._queue.length >= this.maxWaiters) {
      throw new BackpressureError(`Semaphore queue overflow: maxWaiters=${this.maxWaiters}`)
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject }
      this._queue.push(entry)

      if (signal) {
        const onAbort = () => {
          const idx = this._queue.indexOf(entry)
          if (idx >= 0) this._queue.splice(idx, 1)
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        // Wrap resolve to detach the listener on success so we don't
        // leak per-acquire listeners on long-lived signals.
        entry.resolve = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        entry.reject = (err) => {
          signal.removeEventListener('abort', onAbort)
          reject(err)
        }
      }
    })
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift()
      next.resolve()
    } else {
      this.active--
    }
  }

  /**
   * Run fn() while holding a permit. Releases on completion or error.
   * Forwards `signal` to acquire() so cancellation propagates from the
   * waiting state too.
   */
  async run(fn, opts = {}) {
    await this.acquire(opts)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
