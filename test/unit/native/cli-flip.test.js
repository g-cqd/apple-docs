// Unit gate for the RFC 0007 P7 CLI-flip wiring (cli.js → ad-cli): the
// DEFAULT-OFF `cli` switch, the binary allowlist resolution, and the read-verb
// invocation mapping with its conservative fall-back-to-Bun policy. Pure
// functions — no process is spawned here (live parity is cli-parity.test.js).

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { adCliBinaryPath, nativeCliArgs } from '../../../src/native/ad-cli.js'
import { isNativeCliEnabled } from '../../../src/native/loader.js'

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

describe('isNativeCliEnabled — default-off cli gate', () => {
  test('unset / blanket-on never enable cli', () => {
    expect(withNative(undefined, isNativeCliEnabled)).toBe(false)
    expect(withNative('', isNativeCliEnabled)).toBe(false)
    expect(withNative('1', isNativeCliEnabled)).toBe(false)
    expect(withNative('on', isNativeCliEnabled)).toBe(false)
  })
  test('off / 0 force it off', () => {
    expect(withNative('off', isNativeCliEnabled)).toBe(false)
    expect(withNative('0', isNativeCliEnabled)).toBe(false)
  })
  test('explicit cli token enables it (with or without surrounding spaces)', () => {
    expect(withNative('cli', isNativeCliEnabled)).toBe(true)
    expect(withNative('fusion,cli', isNativeCliEnabled)).toBe(true)
    expect(withNative(' fusion , cli ', isNativeCliEnabled)).toBe(true)
  })
  test('other module lists (incl. serve) do not enable it', () => {
    expect(withNative('fusion,archive', isNativeCliEnabled)).toBe(false)
    expect(withNative('serve', isNativeCliEnabled)).toBe(false)
  })
})

describe('adCliBinaryPath — allowlist resolution', () => {
  /** @type {string | undefined} */
  let dir
  afterEach(() => {
    delete process.env.APPLE_DOCS_NATIVE_CLI_BIN
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })
  test('override env: existing file is authoritative', () => {
    dir = mkdtempSync(join(tmpdir(), 'adcli-'))
    const bin = join(dir, 'ad-cli')
    writeFileSync(bin, '')
    process.env.APPLE_DOCS_NATIVE_CLI_BIN = bin
    expect(adCliBinaryPath()).toBe(bin)
  })
  test('override env: missing file → null (no silent fallback to another build)', () => {
    process.env.APPLE_DOCS_NATIVE_CLI_BIN = '/nonexistent/ad-cli'
    expect(adCliBinaryPath()).toBeNull()
  })
  test('no override → a resolved path ending in ad-cli, or null', () => {
    delete process.env.APPLE_DOCS_NATIVE_CLI_BIN
    const path = adCliBinaryPath()
    expect(path === null || path.endsWith('/ad-cli')).toBe(true)
  })
})

describe('nativeCliArgs — read-verb mapping + conservative fallback', () => {
  /** @param {Record<string, unknown>} flags @param {string[]} [positional] @returns {string[] | null} */
  const fw = (flags, positional = []) => nativeCliArgs({ command: 'frameworks', subcommand: undefined, positional, flags, dbPath: DB })
  /** @param {Record<string, unknown>} flags @param {string[]} [positional] @returns {string[] | null} */
  const kinds = (flags, positional = []) => nativeCliArgs({ command: 'kinds', subcommand: undefined, positional, flags, dbPath: DB })

  test('frameworks: bare + --kind + --json pass through', () => {
    expect(fw({})).toEqual(['frameworks', '--db', DB])
    expect(fw({ kind: 'framework' })).toEqual(['frameworks', '--db', DB, '--kind', 'framework'])
    expect(fw({ json: true })).toEqual(['frameworks', '--db', DB, '--json'])
    expect(fw({ kind: 'tooling', json: true })).toEqual(['frameworks', '--db', DB, '--kind', 'tooling', '--json'])
  })
  test('kinds: bare + --field + --json pass through', () => {
    expect(kinds({})).toEqual(['kinds', '--db', DB])
    expect(kinds({ field: 'role' })).toEqual(['kinds', '--db', DB, '--field', 'role'])
    expect(kinds({ json: true })).toEqual(['kinds', '--db', DB, '--json'])
    expect(kinds({ field: 'docKind', json: true })).toEqual(['kinds', '--db', DB, '--field', 'docKind', '--json'])
  })
  test('safe globals (--home folded into dbPath, --verbose stderr-only) do not force Bun', () => {
    expect(fw({ home: '/data', verbose: true })).toEqual(['frameworks', '--db', DB])
    expect(kinds({ field: 'kind', verbose: true })).toEqual(['kinds', '--db', DB, '--field', 'kind'])
  })
  test('unsupported flag → fall back to Bun', () => {
    expect(fw({ limit: '5' })).toBeNull()
    expect(kinds({ all: true })).toBeNull()
    expect(fw({ field: 'role' })).toBeNull() // wrong-verb filter
  })
  test('filter passed without a value (boolean true) → fall back to Bun', () => {
    expect(fw({ kind: true })).toBeNull()
    expect(kinds({ field: true })).toBeNull()
  })
  test('a stray positional or a subcommand → fall back to Bun', () => {
    expect(fw({}, ['extra'])).toBeNull()
    expect(nativeCliArgs({ command: 'frameworks', subcommand: 'x', positional: [], flags: {}, dbPath: DB })).toBeNull()
  })
  test('non-flipped verbs return null', () => {
    expect(nativeCliArgs({ command: 'search', subcommand: undefined, positional: ['view'], flags: {}, dbPath: DB })).toBeNull()
    expect(nativeCliArgs({ command: 'status', subcommand: undefined, positional: [], flags: {}, dbPath: DB })).toBeNull()
    expect(nativeCliArgs({ command: 'read', subcommand: undefined, positional: ['x/y'], flags: {}, dbPath: DB })).toBeNull()
  })
})

describe('nativeCliArgs — browse mapping (positional framework)', () => {
  /** @param {Record<string, unknown>} flags @param {string[]} [positional] @returns {string[] | null} */
  const browse = (flags, positional = ['swiftui']) => nativeCliArgs({ command: 'browse', subcommand: undefined, positional, flags, dbPath: DB })

  test('framework positional + path/limit/year/json pass through', () => {
    expect(browse({})).toEqual(['browse', 'swiftui', '--db', DB])
    expect(browse({ json: true })).toEqual(['browse', 'swiftui', '--db', DB, '--json'])
    expect(browse({ path: 'swiftui/view' })).toEqual(['browse', 'swiftui', '--db', DB, '--path', 'swiftui/view'])
    expect(browse({ limit: '5' })).toEqual(['browse', 'swiftui', '--db', DB, '--limit', '5'])
    expect(browse({ year: '2024' }, ['wwdc'])).toEqual(['browse', 'wwdc', '--db', DB, '--year', '2024'])
  })
  test('exactly one positional required (none → help via Bun; duplicate → Bun)', () => {
    expect(browse({}, [])).toBeNull()
    expect(browse({}, ['a', 'b'])).toBeNull()
  })
  test('non-integer / negative limit or year → fall back to Bun', () => {
    expect(browse({ limit: '5x' })).toBeNull()
    expect(browse({ limit: '-3' })).toBeNull()
    expect(browse({ year: 'abc' }, ['wwdc'])).toBeNull()
  })
  test('--path without a value, or an unsupported flag → fall back', () => {
    expect(browse({ path: true })).toBeNull()
    expect(browse({ source: 'apple' })).toBeNull()
  })
})
