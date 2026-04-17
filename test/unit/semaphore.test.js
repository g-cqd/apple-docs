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
})
