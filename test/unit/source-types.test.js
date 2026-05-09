import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  coerceSourceType,
  DEFAULT_SOURCE_TYPE,
  deriveRootSourceType,
  isSourceType,
  ROOT_SOURCE_TYPE_BY_SLUG,
  SOURCE_TYPES,
} from '../../src/storage/source-types.js'

const SOURCES_DIR = new URL('../../src/sources/', import.meta.url).pathname

function adapterDeclaredTypes() {
  const types = []
  for (const entry of readdirSync(SOURCES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    if (entry.name === 'base.js') continue
    if (entry.name.startsWith('packages-')) continue
    const text = readFileSync(join(SOURCES_DIR, entry.name), 'utf8')
    const match = text.match(/static\s+type\s*=\s*'([^']+)'/)
    if (match) types.push({ file: entry.name, type: match[1] })
  }
  return types
}

describe('source-types enum', () => {
  test('DEFAULT_SOURCE_TYPE is in the enum', () => {
    expect(SOURCE_TYPES).toContain(DEFAULT_SOURCE_TYPE)
  })

  test('isSourceType accepts every enumerated value', () => {
    for (const t of SOURCE_TYPES) expect(isSourceType(t)).toBe(true)
  })

  test('isSourceType rejects unknown values, non-strings, and empties', () => {
    expect(isSourceType('not-real')).toBe(false)
    expect(isSourceType('')).toBe(false)
    expect(isSourceType(null)).toBe(false)
    expect(isSourceType(undefined)).toBe(false)
    expect(isSourceType(42)).toBe(false)
  })

  test('coerceSourceType returns valid input unchanged, default otherwise', () => {
    expect(coerceSourceType('wwdc')).toBe('wwdc')
    expect(coerceSourceType('not-real')).toBe(DEFAULT_SOURCE_TYPE)
    expect(coerceSourceType(null)).toBe(DEFAULT_SOURCE_TYPE)
  })

  test('every ROOT_SOURCE_TYPE_BY_SLUG value is a valid source type', () => {
    for (const value of ROOT_SOURCE_TYPE_BY_SLUG.values()) {
      expect(isSourceType(value)).toBe(true)
    }
  })

  test('deriveRootSourceType falls back to default for unknown slugs', () => {
    expect(deriveRootSourceType('wwdc')).toBe('wwdc')
    expect(deriveRootSourceType('mystery-slug', 'guidelines')).toBe('guidelines')
    expect(deriveRootSourceType('mystery-slug', 'design')).toBe('hig')
    expect(deriveRootSourceType('mystery-slug')).toBe(DEFAULT_SOURCE_TYPE)
  })

  test('drift: every SourceAdapter.type is in SOURCE_TYPES', () => {
    const declared = adapterDeclaredTypes()
    expect(declared.length).toBeGreaterThan(0)
    for (const { file, type } of declared) {
      expect({ file, type, valid: isSourceType(type) }).toEqual({ file, type, valid: true })
    }
  })
})
