// Unit gate for the RFC 0005 Phase E web-serve flip wiring (cli.js → ad-server):
// the DEFAULT-OFF serve switch, the binary allowlist resolution, and the
// invocation mapping with its conservative fall-back-to-Bun policy. Pure
// functions — no process is spawned here (live parity is the ad-server suites).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VERSION } from '../../../src/lib/version.js'
import { adServerBinaryPath, nativeServeArgs } from '../../../src/native/ad-server.js'
import { isNativeServeEnabled } from '../../../src/native/loader.js'

const DB = '/data/apple-docs.db'

/** @param {string | undefined} value @param {() => boolean} fn @returns {boolean} */
function withNative(value, fn) {
  const prev = process.env.APPLE_DOCS_NATIVE
  if (value === undefined) delete process.env.APPLE_DOCS_NATIVE
  else process.env.APPLE_DOCS_NATIVE = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.APPLE_DOCS_NATIVE
    else process.env.APPLE_DOCS_NATIVE = prev
  }
}

describe('isNativeServeEnabled — default-off serve gate', () => {
  test('unset / blanket-on never enable serve', () => {
    expect(withNative(undefined, isNativeServeEnabled)).toBe(false)
    expect(withNative('', isNativeServeEnabled)).toBe(false)
    expect(withNative('1', isNativeServeEnabled)).toBe(false)
    expect(withNative('on', isNativeServeEnabled)).toBe(false)
  })
  test('off / 0 force it off', () => {
    expect(withNative('off', isNativeServeEnabled)).toBe(false)
    expect(withNative('0', isNativeServeEnabled)).toBe(false)
  })
  test('explicit serve token enables it (with or without surrounding spaces)', () => {
    expect(withNative('serve', isNativeServeEnabled)).toBe(true)
    expect(withNative('fusion,serve', isNativeServeEnabled)).toBe(true)
    expect(withNative(' fusion , serve ', isNativeServeEnabled)).toBe(true)
  })
  test('other module lists do not enable it', () => {
    expect(withNative('fusion,archive', isNativeServeEnabled)).toBe(false)
  })
})

describe('adServerBinaryPath — allowlist resolution', () => {
  /** @type {string | undefined} */
  let dir
  afterEach(() => {
    delete process.env.APPLE_DOCS_NATIVE_BIN
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })
  test('override env: existing file is authoritative', () => {
    dir = mkdtempSync(join(tmpdir(), 'adbin-'))
    const bin = join(dir, 'ad-server')
    writeFileSync(bin, '')
    process.env.APPLE_DOCS_NATIVE_BIN = bin
    expect(adServerBinaryPath()).toBe(bin)
  })
  test('override env: missing file → null (no silent fallback to another build)', () => {
    process.env.APPLE_DOCS_NATIVE_BIN = '/nonexistent/ad-server'
    expect(adServerBinaryPath()).toBeNull()
  })
  test('no override → a resolved path ending in ad-server, or null', () => {
    delete process.env.APPLE_DOCS_NATIVE_BIN
    const path = adServerBinaryPath()
    expect(path === null || path.endsWith('/ad-server')).toBe(true)
  })
})

describe('nativeServeArgs — web serve mapping + conservative fallback', () => {
  /** @type {string | undefined} */
  let prevWebHost
  beforeEach(() => {
    prevWebHost = process.env.APPLE_DOCS_WEB_HOST
    delete process.env.APPLE_DOCS_WEB_HOST
  })
  afterEach(() => {
    if (prevWebHost === undefined) delete process.env.APPLE_DOCS_WEB_HOST
    else process.env.APPLE_DOCS_WEB_HOST = prevWebHost
  })

  /** @param {Record<string, unknown>} flags @returns {string[] | null} */
  const web = (flags) => nativeServeArgs({ command: 'web', subcommand: 'serve', flags, dbPath: DB })

  test('default web serve pins the Bun default port (3000) + app-version', () => {
    expect(web({})).toEqual(['serve', '--db', DB, '--port', '3000', '--app-version', VERSION])
  })
  test('explicit port + base-url pass through', () => {
    expect(web({ port: '8080', 'base-url': 'https://x' })).toEqual(['serve', '--db', DB, '--port', '8080', '--app-version', VERSION, '--base-url', 'https://x'])
  })
  test('loopback host delegates; a non-loopback host falls back to Bun', () => {
    expect(web({ host: '127.0.0.1' })).not.toBeNull()
    expect(web({ host: '0.0.0.0' })).toBeNull()
  })
  test('rate-limit / metrics have no native equivalent → fall back to Bun', () => {
    expect(web({ 'rate-limit': true })).toBeNull()
    expect(web({ 'metrics-port': '9090' })).toBeNull()
    expect(web({ 'metrics-host': '127.0.0.1' })).toBeNull()
  })
  test('non-serve verbs return null', () => {
    expect(nativeServeArgs({ command: 'search', subcommand: undefined, flags: {}, dbPath: DB })).toBeNull()
    expect(nativeServeArgs({ command: 'web', subcommand: 'build', flags: {}, dbPath: DB })).toBeNull()
  })
})

describe('nativeServeArgs — mcp serve/start flip (RFC 0005 Phase E)', () => {
  /** @type {string | undefined} */
  let prevWebHost
  beforeEach(() => {
    prevWebHost = process.env.APPLE_DOCS_WEB_HOST
    delete process.env.APPLE_DOCS_WEB_HOST
  })
  afterEach(() => {
    if (prevWebHost === undefined) delete process.env.APPLE_DOCS_WEB_HOST
    else process.env.APPLE_DOCS_WEB_HOST = prevWebHost
  })

  /** @param {Record<string, unknown>} flags @returns {string[] | null} */
  const mcpServe = (flags) => nativeServeArgs({ command: 'mcp', subcommand: 'serve', flags, dbPath: DB })

  test('mcp serve → ad-server serve, pinning the Bun default port (3031)', () => {
    expect(mcpServe({})).toEqual(['serve', '--db', DB, '--port', '3031', '--app-version', VERSION])
    expect(mcpServe({ port: '9000' })).toEqual(['serve', '--db', DB, '--port', '9000', '--app-version', VERSION])
  })
  test('mcp serve falls back to Bun for flags ad-server serve cannot honour', () => {
    expect(mcpServe({ host: '0.0.0.0' })).toBeNull()
    expect(mcpServe({ 'allow-origin': 'https://x' })).toBeNull()
    expect(mcpServe({ concurrency: '8' })).toBeNull()
    expect(mcpServe({ queue: '64' })).toBeNull()
    expect(mcpServe({ 'metrics-port': '9090' })).toBeNull()
    expect(mcpServe({ host: '127.0.0.1' })).not.toBeNull()
  })
  test('mcp start → ad-server mcp (stdio; --db + --app-version only)', () => {
    expect(nativeServeArgs({ command: 'mcp', subcommand: 'start', flags: {}, dbPath: DB })).toEqual(['mcp', '--db', DB, '--app-version', VERSION])
  })
})
