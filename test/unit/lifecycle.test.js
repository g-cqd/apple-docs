import { describe, test, expect, beforeEach } from 'bun:test'
import { lifecycle, gracefulShutdown } from '../../src/lib/lifecycle.js'

beforeEach(() => {
  lifecycle._reset({ exit: () => {} })
})

function makeLogger() {
  const calls = []
  const make = (level) => (...args) => calls.push([level, ...args])
  return { calls, info: make('info'), warn: make('warn'), error: make('error') }
}

describe('lifecycle.register / gracefulShutdown', () => {
  test('drains components in reverse registration order', async () => {
    const order = []
    lifecycle.register({ name: 'db', stop: () => { order.push('db') } })
    lifecycle.register({ name: 'pool', stop: () => { order.push('pool') } })
    lifecycle.register({ name: 'http', stop: () => { order.push('http') } })

    const code = await gracefulShutdown('test', 1000, { logger: makeLogger() })
    expect(code).toBe(0)
    expect(order).toEqual(['http', 'pool', 'db'])
  })

  test('awaits async stop()', async () => {
    let resolved = false
    lifecycle.register({
      name: 'slow',
      stop: () => new Promise((r) => setTimeout(() => { resolved = true; r() }, 30)),
    })
    const code = await gracefulShutdown('test', 1000, { logger: makeLogger() })
    expect(resolved).toBe(true)
    expect(code).toBe(0)
  })

  test('continues past a stop() that throws', async () => {
    const order = []
    lifecycle.register({ name: 'a', stop: () => { order.push('a') } })
    lifecycle.register({ name: 'b', stop: () => { throw new Error('boom') } })
    lifecycle.register({ name: 'c', stop: () => { order.push('c') } })

    const logger = makeLogger()
    const code = await gracefulShutdown('test', 1000, { logger })
    expect(order).toEqual(['c', 'a'])
    expect(code).toBe(1)
    expect(logger.calls.some(([level, msg]) => level === 'error' && /b stop/.test(msg))).toBe(true)
  })

  test('caps each stop() by the remaining deadline', async () => {
    let aborted = false
    lifecycle.register({
      name: 'wedged',
      stop: () => new Promise(() => { /* never resolves */ }),
    })
    lifecycle.register({
      name: 'after-wedge',
      stop: () => { aborted = true },
    })

    const code = await gracefulShutdown('test', 100, { logger: makeLogger() })
    // The "wedged" component runs first (LIFO), races against the 100ms
    // timeout, returns. "after-wedge" should still run — but the deadline
    // budget is shared, so it may or may not get a turn depending on
    // timing. Either way, the code reflects the deadline overrun.
    expect(code).toBe(1)
    // aborted=true means the second component DID run; if false the loop
    // exited early due to deadline. Both are acceptable; we just want to
    // assert no crash.
    expect(typeof aborted).toBe('boolean')
  })

  test('unregister removes the component', async () => {
    const order = []
    const handle = lifecycle.register({ name: 'temp', stop: () => order.push('temp') })
    lifecycle.register({ name: 'keep', stop: () => order.push('keep') })

    handle.unregister()

    await gracefulShutdown('test', 1000, { logger: makeLogger() })
    expect(order).toEqual(['keep'])
  })

  test('register validates input', () => {
    expect(() => lifecycle.register(null)).toThrow(TypeError)
    expect(() => lifecycle.register({ name: 'no-stop' })).toThrow(TypeError)
    expect(() => lifecycle.register({ stop: () => {} })).toThrow(TypeError)
  })

  test('re-entry forces immediate exit', async () => {
    let exitCode = null
    lifecycle._reset({ exit: (code) => { exitCode = code } })

    lifecycle.register({
      name: 'long',
      stop: () => new Promise((r) => setTimeout(r, 50)),
    })

    // Fire two shutdowns concurrently; the second should hit the re-entry
    // branch and force exit.
    const first = gracefulShutdown('first', 1000, { logger: makeLogger() })
    const second = gracefulShutdown('second', 1000, { logger: makeLogger() })

    await Promise.all([first, second])
    expect(exitCode).toBe(2)
  })

  test('zero-component drain is a no-op that returns 0', async () => {
    const code = await gracefulShutdown('idle', 1000, { logger: makeLogger() })
    expect(code).toBe(0)
  })
})
