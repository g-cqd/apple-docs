/**
 * Counting semaphore for bounding global concurrency.
 * All parallel roots share one semaphore so total in-flight fetches are capped.
 */
export class Semaphore {
  constructor(max) {
    this.max = max
    this.active = 0
    this._queue = []
  }

  async acquire() {
    if (this.active < this.max) {
      this.active++
      return
    }
    return new Promise((resolve) => {
      this._queue.push(resolve)
    })
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift()
      next()
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
