/**
 * P2.1 — split reader-pool isolation contract.
 *
 * The motivating regression: with a single shared pool, an artificially
 * slow `searchBody` op held every worker slot and pinned cheap title
 * lookups (`searchTitleExact`) into the multi-second tail. After the
 * split, a held deep op only occupies the deep pool — strict ops still
 * dispatch through the strict pool with low latency.
 *
 * We use a stub Worker class so the test runs without spinning a real
 * SQLite database. Each "worker" is a JS object with `postMessage` /
 * `on`; we drive the lifecycle (ready, message, exit) by hand.
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createReaderPools } from '../../src/storage/reader-pools.js'
import { classifyOp, DEEP_OPS } from '../../src/storage/reader-pool-classifier.js'

class StubWorkerBase extends EventEmitter {
  constructor() {
    super()
    this._terminated = false
    this.constructor.instances.push(this)
    State.outbox.push  // anchor reference so the linter is happy
    // Emit ready on the next microtask so callers can `await ready`.
    queueMicrotask(() => this.emit('message', { type: 'ready' }))
  }
  postMessage(msg) {
    State.outbox.push({ worker: this, kind: this.constructor.kind, msg })
  }
  terminate() {
    this._terminated = true
    return Promise.resolve()
  }
}

class StrictWorkerStub extends StubWorkerBase {}
StrictWorkerStub.kind = 'strict'
StrictWorkerStub.instances = []

class DeepWorkerStub extends StubWorkerBase {}
DeepWorkerStub.kind = 'deep'
DeepWorkerStub.instances = []

const State = { outbox: [] }

function reset() {
  StrictWorkerStub.instances = []
  DeepWorkerStub.instances = []
  State.outbox = []
}

function flushReady(worker, id, data = []) {
  worker.emit('message', { type: 'result', id, ok: true, data })
}

describe('classifyOp', () => {
  test('routes documented heavy ops to deep', () => {
    expect(classifyOp('searchBody')).toBe('deep')
    expect(classifyOp('searchBodyAndEnrich')).toBe('deep')
    expect(classifyOp('fuzzyMatchTitles')).toBe('deep')
    expect(classifyOp('getBodyIndexCount')).toBe('deep')
  })

  test('everything else routes to strict', () => {
    expect(classifyOp('searchTitleExact')).toBe('strict')
    expect(classifyOp('searchPages')).toBe('strict')
    expect(classifyOp('searchTrigram')).toBe('strict')
    expect(classifyOp('getDocument')).toBe('strict')
  })

  test('DEEP_OPS is frozen', () => {
    expect(Object.isFrozen(DEEP_OPS)).toBe(true)
  })
})

describe('createReaderPools', () => {
  function buildPool({ strictSize, deepSize }) {
    return createReaderPools({
      dbPath: '/tmp/fake.db',
      strictSize,
      deepSize,
      strictWorkerCtor: StrictWorkerStub,
      deepWorkerCtor: DeepWorkerStub,
    })
  }

  test('start() spawns separate strict and deep workers', async () => {
    reset()
    const pool = buildPool({ strictSize: 3, deepSize: 2 })
    await pool.start()
    expect(StrictWorkerStub.instances).toHaveLength(3)
    expect(DeepWorkerStub.instances).toHaveLength(2)
    const stats = pool.stats()
    expect(stats.pools.strict.size).toBe(3)
    expect(stats.pools.deep.size).toBe(2)
    expect(stats.size).toBe(5)
    await pool.close()
  })

  test('strict ops dispatch to strict workers; deep ops dispatch to deep workers', async () => {
    reset()
    const pool = buildPool({ strictSize: 2, deepSize: 1 })
    await pool.start()

    const strictPromise = pool.run('searchTitleExact', ['foo'])
    const deepPromise = pool.run('searchBody', ['bar'])
    await Promise.resolve()

    const strictMsgs = State.outbox.filter(o => o.msg.op === 'searchTitleExact')
    const deepMsgs = State.outbox.filter(o => o.msg.op === 'searchBody')
    expect(strictMsgs).toHaveLength(1)
    expect(deepMsgs).toHaveLength(1)
    expect(strictMsgs[0].kind).toBe('strict')
    expect(deepMsgs[0].kind).toBe('deep')

    flushReady(strictMsgs[0].worker, strictMsgs[0].msg.id, ['ok'])
    flushReady(deepMsgs[0].worker, deepMsgs[0].msg.id, ['ok'])
    await Promise.all([strictPromise, deepPromise])
    await pool.close()
  })

  test('strict ops are NOT blocked when every deep slot is busy', async () => {
    reset()
    const pool = buildPool({ strictSize: 2, deepSize: 1 })
    await pool.start()

    // Hold the single deep slot — never resolve this op.
    const heldDeep = pool.run('searchBody', ['held'])
    await Promise.resolve()

    // Fire several strict ops. They must all dispatch and resolve
    // independently of the held deep op.
    const strictPromises = [
      pool.run('searchTitleExact', ['a']),
      pool.run('searchTitleExact', ['b']),
      pool.run('searchTitleExact', ['c']),
    ]
    await Promise.resolve()
    const strictMsgs = State.outbox.filter(o => o.msg.op === 'searchTitleExact')
    expect(strictMsgs).toHaveLength(3)
    for (const m of strictMsgs) expect(m.kind).toBe('strict')

    for (const { worker, msg } of strictMsgs) flushReady(worker, msg.id, ['ok'])
    const settled = await Promise.all(strictPromises)
    expect(settled).toHaveLength(3)

    void heldDeep.catch(() => { /* expected: pool closed */ })
    await pool.close()
  })

  test('stats() aggregates across pools and exposes per-pool detail', async () => {
    reset()
    const pool = buildPool({ strictSize: 4, deepSize: 2 })
    await pool.start()
    const stats = pool.stats()
    expect(stats.size).toBe(6)
    expect(stats.spawns).toBe(6)
    expect(stats.pools.strict.size).toBe(4)
    expect(stats.pools.deep.size).toBe(2)
    await pool.close()
  })
})
