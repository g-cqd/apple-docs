import { describe, test, expect } from 'bun:test'
import { BackpressureError, Semaphore } from '../../src/lib/semaphore.js'

describe('Semaphore', () => {
  test('acquire resolves immediately when under limit', async () => {
    const sem = new Semaphore(2)
    await sem.acquire()
    expect(sem.active).toBe(1)
    await sem.acquire()
    expect(sem.active).toBe(2)
  })

  test('acquire blocks when at limit', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    let acquired = false
    const pending = sem.acquire().then(() => { acquired = true })

    // Give microtask queue a tick
    await Promise.resolve()
    expect(acquired).toBe(false)

    sem.release()
    await pending
    expect(acquired).toBe(true)
  })

  test('release unblocks waiters in FIFO order', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const order = []
    const p1 = sem.acquire().then(() => order.push(1))
    const p2 = sem.acquire().then(() => order.push(2))

    sem.release()
    await p1
    sem.release()
    await p2

    expect(order).toEqual([1, 2])
  })

  test('release decrements active when no waiters', () => {
    const sem = new Semaphore(2)
    sem.active = 2
    sem.release()
    expect(sem.active).toBe(1)
  })

  test('run() acquires and releases on success', async () => {
    const sem = new Semaphore(1)
    const result = await sem.run(() => {
      expect(sem.active).toBe(1)
      return 42
    })
    expect(result).toBe(42)
    expect(sem.active).toBe(0)
  })

  test('run() releases on error', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(() => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sem.active).toBe(0)
  })

  test('run() releases on async error', async () => {
    const sem = new Semaphore(1)
    await expect(sem.run(async () => { throw new Error('async boom') })).rejects.toThrow('async boom')
    expect(sem.active).toBe(0)
  })

  test('concurrent run() respects max concurrency', async () => {
    const sem = new Semaphore(2)
    let maxConcurrent = 0
    let current = 0

    const task = async () => {
      current++
      if (current > maxConcurrent) maxConcurrent = current
      await new Promise(r => setTimeout(r, 10))
      current--
    }

    await Promise.all([
      sem.run(task),
      sem.run(task),
      sem.run(task),
      sem.run(task),
    ])

    expect(maxConcurrent).toBe(2)
    expect(sem.active).toBe(0)
  })

  test('acquire throws BackpressureError when maxWaiters is exceeded', async () => {
    const sem = new Semaphore(1, { maxWaiters: 1 })
    await sem.acquire()

    const firstWaiter = sem.acquire()
    await expect(sem.acquire()).rejects.toBeInstanceOf(BackpressureError)

    sem.release()
    await firstWaiter
    sem.release()
  })

  test('defaults to an unbounded waiter queue when maxWaiters is omitted', async () => {
    const sem = new Semaphore(1)
    await sem.acquire()

    const waiters = [sem.acquire(), sem.acquire(), sem.acquire()]

    sem.release()
    await waiters[0]
    sem.release()
    await waiters[1]
    sem.release()
    await waiters[2]
    sem.release()

    expect(sem.active).toBe(0)
  })

  describe('AbortSignal (P2.8)', () => {
    test('rejects immediately if signal is already aborted at acquire-time', async () => {
      const sem = new Semaphore(1)
      const controller = new AbortController()
      controller.abort(new Error('boom'))
      await expect(sem.acquire({ signal: controller.signal })).rejects.toThrow('boom')
    })

    test('a queued waiter is rejected and removed when its signal aborts', async () => {
      const sem = new Semaphore(1)
      await sem.acquire()                    // permit held by main
      const controller = new AbortController()
      const queued = sem.acquire({ signal: controller.signal })
      // Microtask flush so the waiter is in _queue
      await Promise.resolve()
      expect(sem._queue.length).toBe(1)
      controller.abort(new Error('cancelled'))
      await expect(queued).rejects.toThrow('cancelled')
      expect(sem._queue.length).toBe(0)
      // Releasing should not blow up — no pending waiter to resolve.
      sem.release()
      expect(sem.active).toBe(0)
    })

    test('run() forwards the signal to acquire and surfaces the abort', async () => {
      const sem = new Semaphore(1)
      await sem.acquire()
      const controller = new AbortController()
      let ranBody = false
      const promise = sem.run(async () => { ranBody = true }, { signal: controller.signal })
      await Promise.resolve()
      controller.abort()
      await expect(promise).rejects.toThrow()
      expect(ranBody).toBe(false)
    })

    test('aborting one waiter does not affect a sibling', async () => {
      const sem = new Semaphore(1)
      await sem.acquire()
      const a = new AbortController()
      const queuedA = sem.acquire({ signal: a.signal })
      const queuedB = sem.acquire()
      await Promise.resolve()
      expect(sem._queue.length).toBe(2)
      a.abort()
      await expect(queuedA).rejects.toThrow()
      // Sibling still queued
      expect(sem._queue.length).toBe(1)
      sem.release()
      await queuedB // resolves
    })
  })
})
