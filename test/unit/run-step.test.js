import { describe, expect, test } from 'bun:test'
import { runStep } from '../../src/lib/run-step.js'

describe('runStep', () => {
  test('resolves ok envelope with result + duration on success', async () => {
    const r = await runStep('hello', async () => 42)
    expect(r.ok).toBe(true)
    expect(r.label).toBe('hello')
    if (r.ok) expect(r.result).toBe(42)
    expect(typeof r.ms).toBe('number')
    expect(r.ms).toBeGreaterThanOrEqual(0)
  })

  test('returns failure envelope and swallows error in continue mode', async () => {
    const r = await runStep('boom', async () => {
      throw new Error('nope')
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.message).toBe('nope')
      expect(r.label).toBe('boom')
    }
  })

  test('rethrows in throw mode', async () => {
    await expect(
      runStep('boom', async () => { throw new Error('halt') }, { onError: 'throw' }),
    ).rejects.toThrow('halt')
  })

  test('emits info on ok and warn on failure when a logger is supplied', async () => {
    const records = []
    const logger = {
      info: (msg, data) => records.push({ level: 'info', msg, data }),
      warn: (msg, data) => records.push({ level: 'warn', msg, data }),
    }
    await runStep('a', async () => 1, { logger })
    await runStep('b', async () => { throw new Error('x') }, { logger })
    expect(records.length).toBe(2)
    expect(records[0].level).toBe('info')
    expect(records[0].msg).toBe('a ok')
    expect(records[1].level).toBe('warn')
    expect(records[1].msg).toBe('b failed')
    expect(records[1].data.error).toBe('x')
  })

  test('coerces non-Error throws', async () => {
    const r = await runStep('s', async () => { throw 'string-error' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toBe('string-error')
  })

  test('handles synchronous fn that returns a value', async () => {
    const r = await runStep('sync', () => 'plain')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.result).toBe('plain')
  })
})
