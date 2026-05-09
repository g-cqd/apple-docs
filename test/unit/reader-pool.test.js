import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { createReaderPool, runRead, __defaultReaderPoolSize } from '../../src/storage/reader-pool.js'

// Synchronous event emission — tests can drive responses deterministically.
// Real worker_threads emit asynchronously; for unit tests the behavior is the
// same modulo timing.
function emit(worker, msg) {
  // emit on next microtask so listeners attached after construction still fire
  queueMicrotask(() => worker.emit('message', msg))
}

function makeFakeWorker(handler, { autoReady = true } = {}) {
  const worker = new EventEmitter()
  worker.workerData = null
  worker.postedMessages = []
  worker.terminated = false
  worker.postMessage = (msg) => {
    worker.postedMessages.push(msg)
    if (msg?.type === 'close') {
      queueMicrotask(() => worker.emit('exit', 0))
      return
    }
    handler?.(worker, msg)
  }
  worker.terminate = () => {
    worker.terminated = true
    return Promise.resolve()
  }
  if (autoReady) emit(worker, { type: 'ready' })
  return worker
}

function makeFakeCtor({ handler, onSpawn } = {}) {
  const instances = []
  function FakeCtor(_path, opts) {
    const w = makeFakeWorker(handler)
    w.workerData = opts?.workerData ?? null
    instances.push(w)
    onSpawn?.(w)
    return w
  }
  FakeCtor.instances = instances
  return FakeCtor
}

const DB_PATH = '/tmp/apple-docs-fake.db'

describe('createReaderPool', () => {
  test('defaultReaderPoolSize returns a sane positive number', () => {
    const n = __defaultReaderPoolSize()
    expect(n).toBeGreaterThanOrEqual(2)
    expect(n).toBeLessThanOrEqual(12)
  })

  test('throws when dbPath is missing or :memory:', () => {
    expect(() => createReaderPool({})).toThrow()
    expect(() => createReaderPool({ dbPath: ':memory:' })).toThrow()
  })

  test('start spawns `size` workers and resolves when all are ready', async () => {
    const WorkerCtor = makeFakeCtor()
    const pool = createReaderPool({ dbPath: DB_PATH, size: 3, WorkerCtor })
    await pool.start()
    expect(WorkerCtor.instances).toHaveLength(3)
    expect(pool.stats()).toMatchObject({ size: 3, active: 3, pending: 0, spawns: 3 })
    await pool.close()
  })

  test('run() dispatches to a worker and resolves with the result payload', async () => {
    const handler = (worker, msg) => {
      if (msg.type !== 'call') return
      emit(worker, { type: 'result', id: msg.id, ok: true, data: { op: msg.op, args: msg.args } })
    }
    const WorkerCtor = makeFakeCtor({ handler })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 2, WorkerCtor })
    await pool.start()
    const out = await pool.run('searchPages', ['foo'])
    expect(out).toEqual({ op: 'searchPages', args: ['foo'] })
    await pool.close()
  })

  test('run() surfaces worker error results as rejections', async () => {
    const handler = (worker, msg) => {
      emit(worker, {
        type: 'result', id: msg.id, ok: false, error: { message: 'boom', stack: 'stack' },
      })
    }
    const WorkerCtor = makeFakeCtor({ handler })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 1, WorkerCtor })
    await pool.start()
    await expect(pool.run('searchPages', [])).rejects.toThrow(/boom/)
    await pool.close()
  })

  test('dispatch picks the least-loaded slot', async () => {
    // Hold slot 0's first call open so the second call observes load=1 on
    // slot 0 and load=0 on slot 1.
    let deferred
    const pending = new Promise((resolve) => { deferred = resolve })
    // `WorkerCtor` is only assigned once but is referenced inside `handler`
    // before the assignment statement. `let` avoids biome's no-var warning
    // while letting the closure resolve it lazily at call time.
    // biome-ignore lint/style/useConst: forward reference from closure
    let WorkerCtor
    const handler = (worker, msg) => {
      if (msg.type !== 'call') return
      if (worker === WorkerCtor.instances[0] && msg.id === 1) {
        pending.then(() => emit(worker, { type: 'result', id: msg.id, ok: true, data: 'slow' }))
        return
      }
      emit(worker, { type: 'result', id: msg.id, ok: true, data: `fast:${worker.idx}` })
    }
    WorkerCtor = makeFakeCtor({
      handler,
      onSpawn: (w) => { w.idx = WorkerCtor.instances.length - 1 },
    })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 2, WorkerCtor })
    await pool.start()
    const slow = pool.run('searchPages', [])
    // Let run() progress past `await slot.ready` and actually call
    // `slot.pending.set()` / `postMessage` before we dispatch the second
    // call — otherwise both pickSlot() calls observe load=0 on slot 0 and
    // pile onto it (expected behavior for truly simultaneous dispatches).
    await new Promise((resolve) => queueMicrotask(resolve))
    await new Promise((resolve) => queueMicrotask(resolve))
    expect(pool.stats().pending).toBe(1)
    const fast = await pool.run('searchPages', [])
    expect(fast).toBe('fast:1')
    deferred('done')
    await slow
    await pool.close()
  })

  test('failSlot drains pending promises and respawns lazily on next run', async () => {
    // Mutable handler: first worker never replies, post-respawn worker does.
    let currentHandler = () => {}
    const handler = (worker, msg) => currentHandler(worker, msg)
    const WorkerCtor = makeFakeCtor({ handler })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 1, WorkerCtor })
    await pool.start()

    const first = pool.run('searchPages', [])
    // Let run() enroll the pending entry before we emit exit, so failSlot
    // actually drains it. Without this the exit races run() past the await
    // and the first promise would hang (a real pool race we're not covering
    // here — noted in the pool's comment about post-await closed checks).
    await new Promise((resolve) => queueMicrotask(resolve))
    await new Promise((resolve) => queueMicrotask(resolve))
    // Trigger a crash on slot 0.
    WorkerCtor.instances[0].emit('exit', 7)
    await expect(first).rejects.toThrow(/exited with code 7/)

    // Switch handler so the respawned worker responds.
    currentHandler = (worker, msg) => {
      if (msg.type === 'call') emit(worker, { type: 'result', id: msg.id, ok: true, data: 'ok' })
    }

    const result = await pool.run('searchPages', [])
    expect(result).toBe('ok')
    expect(WorkerCtor.instances).toHaveLength(2) // original + respawn
    await pool.close()
  })

  test('close rejects in-flight calls and terminates every worker', async () => {
    const WorkerCtor = makeFakeCtor({ handler: () => {} })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 2, WorkerCtor })
    await pool.start()
    const inflight = pool.run('searchPages', [])
    // Let run() enroll its pending entry before we invoke close().
    await new Promise((resolve) => queueMicrotask(resolve))
    await new Promise((resolve) => queueMicrotask(resolve))
    expect(pool.stats().pending).toBe(1)

    await pool.close()
    await expect(inflight).rejects.toThrow(/closed/)
    expect(WorkerCtor.instances.every(w => w.terminated)).toBe(true)
    await expect(pool.run('searchPages', [])).rejects.toThrow(/after close/)
  })

  test('close({ softDrainMs }) waits for in-flight calls to settle (P1.3)', async () => {
    // Worker that completes the call after a short delay.
    const handler = (worker, msg) => {
      if (msg.type !== 'call') return
      setTimeout(() => emit(worker, { type: 'result', id: msg.id, ok: true, data: 'late-ok' }), 60)
    }
    const WorkerCtor = makeFakeCtor({ handler })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 1, WorkerCtor })
    await pool.start()
    const inflight = pool.run('searchPages', [])
    await new Promise((resolve) => queueMicrotask(resolve))
    expect(pool.stats().pending).toBe(1)

    await pool.close({ softDrainMs: 500 })
    // The drain loop should have noticed the pending entry clear before the
    // worker is terminated, so the call resolves normally.
    await expect(inflight).resolves.toBe('late-ok')
    expect(WorkerCtor.instances.every(w => w.terminated)).toBe(true)
  })

  test('recycle tears down all workers and respawns a fresh set', async () => {
    const handler = (worker, msg) => {
      if (msg.type === 'call') emit(worker, { type: 'result', id: msg.id, ok: true, data: 'ok' })
    }
    const WorkerCtor = makeFakeCtor({ handler })
    const pool = createReaderPool({ dbPath: DB_PATH, size: 2, WorkerCtor })
    await pool.start()
    const beforeStats = pool.stats()
    expect(beforeStats.spawns).toBe(2)

    await pool.recycle()
    const afterStats = pool.stats()
    expect(afterStats.spawns).toBe(4) // two fresh workers
    expect(WorkerCtor.instances.slice(0, 2).every(w => w.terminated)).toBe(true)

    expect(await pool.run('searchPages', [])).toBe('ok')
    await pool.close()
  })

  test('spawn failure (fatal message) rejects start()', async () => {
    function FailingCtor() {
      const w = makeFakeWorker(null, { autoReady: false })
      queueMicrotask(() => w.emit('message', {
        type: 'fatal', error: { message: 'db open failed' },
      }))
      return w
    }
    const pool = createReaderPool({ dbPath: DB_PATH, size: 1, WorkerCtor: FailingCtor })
    await expect(pool.start()).rejects.toThrow(/db open failed|reader-worker fatal/)
    await pool.close()
  })
})

describe('runRead', () => {
  test('routes through pool.run when ctx.readerPool is present', async () => {
    const calls = []
    const fakePool = {
      run: (op, args) => { calls.push({ op, args }); return Promise.resolve('via-pool') },
    }
    const result = await runRead({ readerPool: fakePool }, 'getPage', ['foo'])
    expect(result).toBe('via-pool')
    expect(calls).toEqual([{ op: 'getPage', args: ['foo'] }])
  })

  test('falls back to ctx.db[op] when no pool is wired', async () => {
    const db = { getPage: (path) => `direct:${path}` }
    const result = await runRead({ db }, 'getPage', ['bar'])
    expect(result).toBe('direct:bar')
  })

  test('throws when the method does not exist on ctx.db', async () => {
    await expect(runRead({ db: {} }, 'nope', [])).rejects.toThrow(/no method nope/)
  })
})
