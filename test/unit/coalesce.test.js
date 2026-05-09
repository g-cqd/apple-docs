import { afterEach, describe, expect, test } from 'bun:test'
import {
  _coalesceInflightCount,
  _resetCoalesceForTests,
  coalesceByKey,
} from '../../src/pipeline/coalesce.js'

describe('coalesceByKey', () => {
  afterEach(() => _resetCoalesceForTests())

  test('runs fn once per key for concurrent callers', async () => {
    let calls = 0
    let resolveFn
    const pending = new Promise(r => { resolveFn = r })
    const fn = async () => { calls += 1; await pending; return 'done' }

    const a = coalesceByKey('k', fn)
    const b = coalesceByKey('k', fn)
    const c = coalesceByKey('k', fn)

    expect(_coalesceInflightCount()).toBe(1)
    resolveFn()
    const results = await Promise.all([a, b, c])
    expect(calls).toBe(1)
    expect(results).toEqual(['done', 'done', 'done'])
  })

  test('different keys do not coalesce', async () => {
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    const [a, b] = await Promise.all([
      coalesceByKey('a', fn),
      coalesceByKey('b', fn),
    ])
    expect(calls).toBe(2)
    expect(new Set([a, b])).toEqual(new Set([1, 2]))
  })

  test('clears the entry after success so a later miss can re-fetch', async () => {
    let calls = 0
    const fn = async () => { calls += 1 }
    await coalesceByKey('k', fn)
    expect(_coalesceInflightCount()).toBe(0)
    await coalesceByKey('k', fn)
    expect(calls).toBe(2)
  })

  test('clears the entry after failure', async () => {
    const err = new Error('boom')
    await expect(coalesceByKey('k', async () => { throw err })).rejects.toBe(err)
    expect(_coalesceInflightCount()).toBe(0)
    // Subsequent call works normally.
    await expect(coalesceByKey('k', async () => 'ok')).resolves.toBe('ok')
  })

  test('all concurrent callers receive the same rejection', async () => {
    const err = new Error('shared failure')
    const fn = async () => { throw err }
    const [a, b] = await Promise.allSettled([
      coalesceByKey('k', fn),
      coalesceByKey('k', fn),
    ])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('rejected')
    expect(a.reason).toBe(err)
    expect(b.reason).toBe(err)
  })
})
