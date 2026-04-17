/**
 * Counting semaphore for bounding global concurrency.
 * All parallel roots share one semaphore so total in-flight fetches are capped.
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

  async acquire() {
    if (this.active < this.max) {
      this.active++
      return
    }

    if (this.maxWaiters != null && this._queue.length >= this.maxWaiters) {
      throw new BackpressureError(`Semaphore queue overflow: maxWaiters=${this.maxWaiters}`)
    }

    return new Promise((resolve) => {
      this._queue.push({ resolve })
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
   */
  async run(fn) {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}
