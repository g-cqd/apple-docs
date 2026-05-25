/**
 * Unit-level test for the search-worker's base-URL origin check.
 *
 * The full browser smoke is in
 * `test/integration/search-worker-browser.test.js`; this suite runs in
 * Bun without Playwright by parsing the worker source and exercising
 * its `validateBase` helper against rejected and accepted shapes.
 *
 * Threat model recap: the worker is fetched from `/worker/search-worker.js`
 * on the same origin as the host page; postMessage from any same-origin
 * script can feed it a `base` URL. An attacker who controls a same-origin
 * subframe must not be able to redirect the worker's index-load fetches
 * at an external host to exfiltrate the document index (which would
 * carry the worker's session credentials). Reject every base whose
 * origin doesn't match the worker's own.
 */

import { describe, test, expect, beforeAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let validateBase

beforeAll(() => {
  const src = readFileSync(
    join(import.meta.dir, '../../../src/web/worker/search-worker.js'),
    'utf8',
  )
  // Extract just the validateBase function. Easier than mocking `self`
  // and re-running the whole module; the function is self-contained.
  const match = src.match(/function validateBase[\s\S]+?\n\}\n/m)
  if (!match) throw new Error('validateBase not found in search-worker.js')
  // Provide a stub `self.location` so the function resolves URLs.
  const stubbedSrc = `
    const self = { location: new URL('https://docs.example.com/') };
    ${match[0]}
    return validateBase;
  `
  validateBase = new Function(stubbedSrc)()
})

describe('search-worker.validateBase', () => {
  test('accepts empty / undefined / null base', () => {
    expect(validateBase('')).toBe('')
    expect(validateBase(undefined)).toBe('')
    expect(validateBase(null)).toBe('')
  })

  test('accepts a root-relative path', () => {
    expect(validateBase('/api')).toBe('/api')
    expect(validateBase('/some/sub')).toBe('/some/sub')
  })

  test('rejects scheme-relative (protocol-relative) URLs', () => {
    expect(() => validateBase('//evil.example')).toThrow()
  })

  test('accepts an absolute URL with the worker origin', () => {
    expect(validateBase('https://docs.example.com')).toBe('https://docs.example.com')
    expect(validateBase('https://docs.example.com/api')).toBe('https://docs.example.com/api')
  })

  test('rejects an absolute URL with a different origin', () => {
    expect(() => validateBase('https://evil.example')).toThrow(/origin/)
    expect(() => validateBase('http://docs.example.com')).toThrow(/origin/) // different scheme = different origin
    expect(() => validateBase('https://docs.example.com:1234')).toThrow(/origin/) // different port = different origin
  })

  test('rejects garbage', () => {
    expect(() => validateBase('javascript:alert(1)')).toThrow()
    expect(() => validateBase(42)).toThrow()
    expect(() => validateBase({})).toThrow()
  })
})
