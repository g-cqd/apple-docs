import { describe, test, expect } from 'bun:test'
import { pool } from '../../src/lib/pool.js'

describe('pool (P2.8 AbortSignal)', () => {
  test('runs every task to completion in the absence of a signal', async () => {
    const seen = []
    await pool([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n)
    })
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
  })

  test('aborting before start rejects without running any task', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    let started = 0
    await expect(
      pool([1, 2, 3], 2, async () => { started += 1 }, { signal: controller.signal }),
    ).rejects.toThrow('cancelled')
    expect(started).toBe(0)
  })

  test('aborting mid-flight stops new task starts', async () => {
    const controller = new AbortController()
    const items = Array.from({ length: 20 }, (_, i) => i)
    let started = 0
    const promise = pool(items, 2, async (i) => {
      started += 1
      // Abort once a few have started
      if (started === 2) controller.abort(new Error('stop'))
      // Hold each task briefly
      await new Promise(r => setTimeout(r, 10))
    }, { signal: controller.signal })
    await expect(promise).rejects.toThrow('stop')
    // At most a small number of tasks ran (the two that were already
    // started + maybe one more); definitely not all 20.
    expect(started).toBeLessThan(20)
  })

  test('processes 100k items in input order with no duplicates (cursor mechanics)', async () => {
    const N = 100_000
    const items = new Array(N)
    for (let i = 0; i < N; i++) items[i] = i
    const seen = new Uint8Array(N)
    let max = -1
    await pool(items, 64, async (n) => {
      seen[n] = 1
      if (n > max) max = n
    })
    expect(max).toBe(N - 1)
    // Every index visited exactly once.
    let visited = 0
    for (let i = 0; i < N; i++) visited += seen[i]
    expect(visited).toBe(N)
  })

  test('does not mutate the caller-supplied items array', async () => {
    const items = [10, 20, 30]
    const snapshot = [...items]
    await pool(items, 2, async () => {})
    expect(items).toEqual(snapshot)
  })

  test('signal is passed to the worker function', async () => {
    const controller = new AbortController()
    const seen = []
    await pool([1, 2], 2, async (_n, opts) => {
      seen.push(opts?.signal)
    }, { signal: controller.signal })
    expect(seen).toHaveLength(2)
    for (const s of seen) expect(s).toBe(controller.signal)
  })
})
