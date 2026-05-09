import { describe, expect, test } from 'bun:test'
import { redact } from '../../src/lib/logger.js'

describe('logger redaction (A30)', () => {
  test('redacts top-level sensitive keys', () => {
    expect(redact({ token: 'abc', user: 'alice' }))
      .toEqual({ token: '<redacted>', user: 'alice' })
    expect(redact({ Authorization: 'Bearer xyz' }))
      .toEqual({ Authorization: '<redacted>' })
    expect(redact({ cookie: 'sid=…' }))
      .toEqual({ cookie: '<redacted>' })
    expect(redact({ apiKey: 'pk_…' }))
      .toEqual({ apiKey: '<redacted>' })
    expect(redact({ api_key: 'pk_…' }))
      .toEqual({ api_key: '<redacted>' })
  })

  test('redacts nested sensitive keys', () => {
    expect(redact({ outer: { secret: 'shh' } }))
      .toEqual({ outer: { secret: '<redacted>' } })
  })

  test('redacts inside arrays', () => {
    expect(redact([{ password: 'pw' }, { user: 'a' }]))
      .toEqual([{ password: '<redacted>' }, { user: 'a' }])
  })

  test('passes through primitives', () => {
    expect(redact('hello')).toBe('hello')
    expect(redact(42)).toBe(42)
    expect(redact(null)).toBe(null)
    expect(redact(undefined)).toBeUndefined()
  })

  test('caps depth at 8 frames', () => {
    let value = { leaf: 'x' }
    for (let i = 0; i < 12; i++) value = { nested: value }
    const result = JSON.stringify(redact(value))
    expect(result).toContain('<deep>')
  })

  test('non-sensitive keys preserved verbatim', () => {
    const input = { name: 'Alice', age: 30, address: { city: 'NYC' } }
    expect(redact(input)).toEqual(input)
  })
})
