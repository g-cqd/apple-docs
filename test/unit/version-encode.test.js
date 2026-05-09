import { describe, expect, test } from 'bun:test'
import { encodeVersion } from '../../src/lib/version-encode.js'

describe('encodeVersion', () => {
  test('returns null for null/undefined/empty', () => {
    expect(encodeVersion(null)).toBeNull()
    expect(encodeVersion(undefined)).toBeNull()
    expect(encodeVersion('')).toBeNull()
    expect(encodeVersion('   ')).toBeNull()
  })

  test('encodes major.minor.patch into a strictly increasing integer', () => {
    expect(encodeVersion('9.0')).toBeLessThan(encodeVersion('10.0'))
    expect(encodeVersion('10.0')).toBeLessThan(encodeVersion('10.1'))
    expect(encodeVersion('10.1')).toBeLessThan(encodeVersion('10.1.1'))
    expect(encodeVersion('17.4')).toBeGreaterThan(encodeVersion('17.3'))
  })

  test('major-only and major.minor parse identically to padded forms', () => {
    expect(encodeVersion('17')).toBe(encodeVersion('17.0'))
    expect(encodeVersion('17.0')).toBe(encodeVersion('17.0.0'))
  })

  test('returns null for malformed input', () => {
    expect(encodeVersion('abc')).toBeNull()
    expect(encodeVersion('-1.0')).toBeNull()
  })

  test('strips trailing markers like " beta"', () => {
    // Apple has shipped strings like "16.0 beta" historically; we want
    // the numeric prefix to round-trip into a valid encoding.
    expect(encodeVersion('16.0 beta')).toBe(encodeVersion('16.0'))
  })
})
