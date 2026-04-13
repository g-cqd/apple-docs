import { describe, expect, test } from 'bun:test'
import { sync } from '../../src/commands/sync.js'
import { normalizeList, validateRequestedSources, filterPages, filterPagesByRoots } from '../../src/commands/command-helpers.js'

describe('sync command', () => {
  test('rejects unknown source filters before running discovery', async () => {
    await expect(sync({
      sources: ['not-a-source'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('Unknown source type(s): not-a-source')
  })

  test('rejects multiple unknown sources with all names listed', async () => {
    await expect(sync({
      sources: ['fake-one', 'fake-two'],
    }, {
      db: null,
      dataDir: '/tmp',
      rateLimiter: null,
      logger: { info() {}, warn() {}, error() {} },
    })).rejects.toThrow('fake-one')
  })
})

describe('command helpers (used by sync)', () => {
  test('normalizeList returns null for undefined', () => {
    expect(normalizeList(undefined)).toBeNull()
    expect(normalizeList(null)).toBeNull()
  })

  test('normalizeList returns empty array for empty array', () => {
    expect(normalizeList([])).toEqual([])
  })

  test('normalizeList lowercases values', () => {
    expect(normalizeList(['SwiftUI', 'UIKit'])).toEqual(['swiftui', 'uikit'])
  })

  test('validateRequestedSources passes for null', () => {
    expect(() => validateRequestedSources(null)).not.toThrow()
  })

  test('validateRequestedSources passes for valid source types', () => {
    expect(() => validateRequestedSources(['apple-docc'])).not.toThrow()
  })

  test('validateRequestedSources throws for unknown source', () => {
    expect(() => validateRequestedSources(['fake-source'])).toThrow('Unknown source type(s)')
  })

  test('filterPages filters by root slug', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'uikit', source_type: 'apple-docc', path: 'b' },
    ]
    const result = filterPages(pages, ['swiftui'], null)
    expect(result.length).toBe(1)
    expect(result[0].path).toBe('a')
  })

  test('filterPages filters by source type', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'proposals', source_type: 'swift-evolution', path: 'b' },
    ]
    const result = filterPages(pages, null, ['swift-evolution'])
    expect(result.length).toBe(1)
    expect(result[0].path).toBe('b')
  })

  test('filterPages returns all when no filters', () => {
    const pages = [
      { root_slug: 'swiftui', source_type: 'apple-docc', path: 'a' },
      { root_slug: 'proposals', source_type: 'swift-evolution', path: 'b' },
    ]
    const result = filterPages(pages, null, null)
    expect(result.length).toBe(2)
  })

  test('filterPagesByRoots filters correctly', () => {
    const pages = [
      { root_slug: 'swiftui', path: 'a' },
      { root_slug: 'uikit', path: 'b' },
    ]
    expect(filterPagesByRoots(pages, ['swiftui']).length).toBe(1)
    expect(filterPagesByRoots(pages, null).length).toBe(2)
  })
})
