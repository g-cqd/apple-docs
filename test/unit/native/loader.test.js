import { suffix } from 'bun:ffi'
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { _resetNativeLoader, getNativeLib, isNativeEnabled } from '../../../src/native/loader.js'
import { readNativeResult } from '../../../src/native/result.js'

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname

afterEach(() => {
  delete process.env.APPLE_DOCS_NATIVE
  delete process.env.APPLE_DOCS_NATIVE_LIB
  _resetNativeLoader()
})

describe('isNativeEnabled', () => {
  test('native by default; off only for the explicit escape hatch', () => {
    // RFC 0002 phase 5: unset/'' mean native-on (JS still serves wherever
    // the dylib or its artifacts are absent — outputs are bit-identical).
    delete process.env.APPLE_DOCS_NATIVE
    expect(isNativeEnabled('fusion')).toBe(true)
    process.env.APPLE_DOCS_NATIVE = ''
    expect(isNativeEnabled('embed')).toBe(true)
    for (const value of ['0', 'off', ' OFF ']) {
      process.env.APPLE_DOCS_NATIVE = value
      expect(isNativeEnabled('fusion')).toBe(false)
      expect(isNativeEnabled('embed')).toBe(false)
    }
  })

  test('global on values enable every module', () => {
    for (const value of ['1', 'on', ' ON ']) {
      process.env.APPLE_DOCS_NATIVE = value
      expect(isNativeEnabled('fusion')).toBe(true)
      expect(isNativeEnabled('anything')).toBe(true)
    }
  })

  test('csv enables listed modules only', () => {
    process.env.APPLE_DOCS_NATIVE = 'fusion, ranking'
    expect(isNativeEnabled('fusion')).toBe(true)
    expect(isNativeEnabled('ranking')).toBe(true)
    expect(isNativeEnabled('snippets')).toBe(false)
  })
})

describe('getNativeLib', () => {
  test('bogus explicit override memoizes null without throwing or falling through', () => {
    process.env.APPLE_DOCS_NATIVE_LIB = '/nonexistent/libAppleDocsCore.dylib'
    _resetNativeLoader()
    expect(getNativeLib()).toBeNull()
    // Memoized: stays null within the process until reset.
    expect(getNativeLib()).toBeNull()
  })

  test('_resetNativeLoader lets env changes take effect', () => {
    process.env.APPLE_DOCS_NATIVE_LIB = '/nonexistent/lib.dylib'
    _resetNativeLoader()
    expect(getNativeLib()).toBeNull()
    delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
    // Resolution now follows the default chain — result depends on whether
    // a dev build exists, but it must not throw either way.
    expect(() => getNativeLib()).not.toThrow()
  })
})

describe.skipIf(!existsSync(DEV_LIB))('with a built dylib', () => {
  test('loads, passes the ABI handshake, echoes bytes', () => {
    delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
    const lib = getNativeLib()
    expect(lib).not.toBeNull()
    const blob = crypto.getRandomValues(new Uint8Array(256))
    const result = readNativeResult(lib, lib.symbols.ad_echo(blob, blob.length))
    expect(result.status).toBe(0)
    expect(Buffer.compare(Buffer.from(result.bytes), Buffer.from(blob))).toBe(0)
  })

  test('explicit override pointing at the dev build loads too', () => {
    process.env.APPLE_DOCS_NATIVE_LIB = DEV_LIB
    _resetNativeLoader()
    expect(getNativeLib()).not.toBeNull()
  })
})
