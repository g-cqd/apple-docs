export class RateLimiter {
  /**
   * Token bucket rate limiter.
   * @param {number} rate - tokens per second
   * @param {number} burst - max tokens available at once
   */
  constructor(rate = 5, burst = 2) {
    this.rate = rate
    this.burst = burst
    this.tokens = burst
    this.lastRefill = Date.now()
    this._queue = []
    this._processing = false
  }

  async acquire() {
    return new Promise((resolve) => {
      this._queue.push(resolve)
      this._process()
    })
  }

  _refill() {
    const now = Date.now()
    const elapsed = (now - this.lastRefill) / 1000
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate)
    this.lastRefill = now
  }

  _process() {
    if (this._processing) return
    this._processing = true

    const tick = () => {
      if (this._queue.length === 0) {
        this._processing = false
        return
      }

      this._refill()

      if (this.tokens >= 1) {
        this.tokens -= 1
        const resolve = this._queue.shift()
        resolve()
        // Process next immediately if tokens remain
        if (this._queue.length > 0) {
          queueMicrotask(tick)
        } else {
          this._processing = false
        }
      } else {
        const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000)
        setTimeout(tick, waitMs)
      }
    }

    tick()
  }
}
