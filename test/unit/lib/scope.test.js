// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { filterAdaptersByScope, loadScope, scopeRootsFor } from '../../../src/lib/scope.js'
import { getAllAdapters } from '../../../src/sources/registry.js'

let dataDir

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-scope-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function writeScope(obj) {
  writeFileSync(join(dataDir, 'scope.json'), JSON.stringify(obj))
}

describe('loadScope', () => {
  test('absent file → null (full coverage stays the default)', () => {
    expect(loadScope(dataDir)).toBeNull()
  })

  test('parses, normalizes, and defaults keep flags to true', () => {
    writeScope({
      version: 1,
      sources: ['Apple-DocC', 'hig', 'hig'],
      appleDoccFrameworks: [' SwiftUI ', 'combine'],
    })
    const scope = loadScope(dataDir)
    expect(scope.sources).toEqual(['apple-docc', 'hig'])
    expect(scope.appleDoccFrameworks).toEqual(['swiftui', 'combine'])
    expect(scope.keepFonts).toBe(true)
    expect(scope.keepSymbols).toBe(true)
  })

  test('invalid JSON throws with the file path', () => {
    writeFileSync(join(dataDir, 'scope.json'), '{nope')
    expect(() => loadScope(dataDir)).toThrow(/scope\.json/)
  })

  test('unknown source names the valid ones', () => {
    writeScope({ version: 1, sources: ['swiftui'] })
    expect(() => loadScope(dataDir)).toThrow(/unknown source\(s\): swiftui.*apple-docc/)
  })

  test('frameworks without apple-docc in sources is rejected', () => {
    writeScope({ version: 1, sources: ['hig'], appleDoccFrameworks: ['swiftui'] })
    expect(() => loadScope(dataDir)).toThrow(/apple-docc.*not in sources/)
  })

  test('missing or wrong version is rejected', () => {
    writeScope({ sources: ['hig'] })
    expect(() => loadScope(dataDir)).toThrow(/unsupported version/)
  })

  test('keepFonts/keepSymbols false are honored', () => {
    writeScope({ version: 1, keepFonts: false, keepSymbols: false })
    const scope = loadScope(dataDir)
    expect(scope.keepFonts).toBe(false)
    expect(scope.keepSymbols).toBe(false)
    expect(scope.sources).toBeNull()
  })
})

describe('filterAdaptersByScope / scopeRootsFor', () => {
  test('no scope or no sources → adapters unchanged', () => {
    const adapters = getAllAdapters()
    expect(filterAdaptersByScope(adapters, null)).toBe(adapters)
    expect(filterAdaptersByScope(adapters, { sources: null })).toBe(adapters)
  })

  test('sources restriction filters adapters by type', () => {
    const adapters = getAllAdapters()
    const filtered = filterAdaptersByScope(adapters, { sources: ['wwdc', 'hig'] })
    expect(filtered.map((a) => a.constructor.type).sort()).toEqual(['hig', 'wwdc'])
  })

  test('framework narrowing applies ONLY to apple-docc', () => {
    const adapters = getAllAdapters()
    const docc = adapters.find((a) => a.constructor.type === 'apple-docc')
    const wwdc = adapters.find((a) => a.constructor.type === 'wwdc')
    const scope = { sources: null, appleDoccFrameworks: ['swiftui'] }
    expect(scopeRootsFor(docc, scope)).toEqual(['swiftui'])
    expect(scopeRootsFor(wwdc, scope)).toBeNull()
    expect(scopeRootsFor(docc, null)).toBeNull()
  })
})
