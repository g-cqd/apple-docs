import { describe, test, expect, beforeEach } from 'bun:test'
import { safeCall, _resetWarnedLabels } from '../../src/lib/safe-call.js'

function makeLogger() {
  const calls = []
  return {
    calls,
    debug: (...args) => calls.push(['debug', ...args]),
    info: (...args) => calls.push(['info', ...args]),
    warn: (...args) => calls.push(['warn', ...args]),
    error: (...args) => calls.push(['error', ...args]),
  }
}

beforeEach(() => {
  _resetWarnedLabels()
})

describe('safeCall (sync)', () => {
  test('returns the wrapped value on success', () => {
    expect(safeCall(() => 42)).toBe(42)
  })

  test('returns the default on throw', () => {
    const logger = makeLogger()
    const out = safeCall(() => { throw new Error('boom') }, { default: 'fallback', logger })
    expect(out).toBe('fallback')
  })

  test('returns undefined when no default is provided', () => {
    const logger = makeLogger()
    expect(safeCall(() => { throw new Error('x') }, { logger })).toBeUndefined()
  })

  test('default log mode is warn (failures surface)', () => {
    const logger = makeLogger()
    safeCall(() => { throw new Error('boom') }, { logger })
    const warns = logger.calls.filter(([level]) => level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0][1]).toContain('safeCall')
  })

  test('silent mode never logs', () => {
    const logger = makeLogger()
    safeCall(() => { throw new Error('boom') }, { log: 'silent', logger })
    expect(logger.calls).toEqual([])
  })

  test('warn-once dedups by label across calls', () => {
    const logger = makeLogger()
    safeCall(() => { throw new Error('a') }, { log: 'warn-once', label: 'p1', logger })
    safeCall(() => { throw new Error('b') }, { log: 'warn-once', label: 'p1', logger })
    safeCall(() => { throw new Error('c') }, { log: 'warn-once', label: 'p2', logger })
    expect(logger.calls.filter(([level]) => level === 'warn')).toHaveLength(2)
  })

  test('label appears in the log message', () => {
    const logger = makeLogger()
    safeCall(() => { throw new Error('boom') }, { label: 'parse-platforms', logger })
    expect(logger.calls[0][1]).toContain('parse-platforms')
  })

  test('error data includes message + stack', () => {
    const logger = makeLogger()
    safeCall(() => { throw new Error('details here') }, { logger })
    const data = logger.calls[0][2]
    expect(data.error).toBe('details here')
    expect(data.stack).toBeDefined()
  })
})

describe('safeCall (async)', () => {
  test('awaits the promise on success', async () => {
    const out = await safeCall(() => Promise.resolve('ok'))
    expect(out).toBe('ok')
  })

  test('returns the default on rejection', async () => {
    const logger = makeLogger()
    const out = await safeCall(() => Promise.reject(new Error('async-fail')), {
      default: [],
      logger,
    })
    expect(out).toEqual([])
  })

  test('warn-once works across async calls too', async () => {
    const logger = makeLogger()
    await safeCall(() => Promise.reject(new Error('x')), { log: 'warn-once', label: 'fts', logger })
    await safeCall(() => Promise.reject(new Error('y')), { log: 'warn-once', label: 'fts', logger })
    await safeCall(() => Promise.reject(new Error('z')), { log: 'warn-once', label: 'fts', logger })
    expect(logger.calls.filter(([level]) => level === 'warn')).toHaveLength(1)
  })

  test('async fn that throws synchronously is caught too', async () => {
    const logger = makeLogger()
    const result = safeCall(() => { throw new Error('sync-throw-in-async-context') }, {
      default: 'fallback',
      logger,
    })
    // Sync throw → sync return path, no Promise wrapping.
    expect(result).toBe('fallback')
  })
})
