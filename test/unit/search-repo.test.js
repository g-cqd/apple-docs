import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  // Seed a tiny corpus
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  for (const [path, title, kind] of [
    ['swiftui/view', 'View', 'symbol'],
    ['swiftui/text', 'Text', 'symbol'],
    ['swiftui/button', 'Button', 'symbol'],
    ['swiftui/navigationstack', 'NavigationStack', 'symbol'],
    ['swiftui/articles/composing-views', 'Composing views', 'article'],
  ]) {
    db.upsertPage({
      rootId: root.id,
      path,
      url: `https://developer.apple.com/documentation/${path}`,
      title,
      role: kind,
      sourceType: 'apple-docc',
    })
  }
})

afterEach(() => {
  db.close()
})

describe('search repo via DocsDatabase facade', () => {
  test('search.searchPages finds documents via FTS5', () => {
    const rows = db.searchPages('"View"', 'View', { limit: 10 })
    expect(rows.find(r => r.path === 'swiftui/view')).toBeDefined()
  })

  test('search.searchPages includes tier and rank', () => {
    const rows = db.searchPages('"View"', 'View', { limit: 10 })
    const view = rows.find(r => r.path === 'swiftui/view')
    expect(view).toBeDefined()
    expect(view.tier).toBe(0) // exact title match
    expect(typeof view.rank).toBe('number')
  })

  test('search.searchTitleExact returns case-insensitive title hits', () => {
    const rows = db.searchTitleExact('button', { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0].path).toBe('swiftui/button')
    expect(rows[0].tier).toBe(0)
  })

  test('search.searchTrigram bypasses FTS for fuzzy matches', () => {
    // Trigram tolerates one-character substring matches.
    const rows = db.searchTrigram('"navi"', { limit: 10 })
    expect(rows.find(r => r.path === 'swiftui/navigationstack')).toBeDefined()
  })

  test('framework filter applies across all variants', () => {
    expect(db.searchPages('"View"', 'View', { framework: 'swiftui', limit: 10 }).length).toBeGreaterThan(0)
    expect(db.searchPages('"View"', 'View', { framework: 'nonexistent', limit: 10 })).toEqual([])
  })

  test('searchByTitle returns the best single row', () => {
    const row = db.searchByTitle('Text')
    expect(row?.title).toBe('Text')
    expect(row?.key).toBe('swiftui/text')
  })

  test('getBodyIndexCount returns 0 when no body index populated', () => {
    expect(db.getBodyIndexCount()).toBe(0)
  })

  test('getAllTitlesForFuzzy returns id+title rows', () => {
    const all = db.getAllTitlesForFuzzy()
    expect(all.length).toBeGreaterThanOrEqual(5)
    for (const row of all) {
      expect(typeof row.id).toBe('number')
      expect(typeof row.title).toBe('string')
    }
  })

  test('getFrameworkSynonyms returns symmetric matches', () => {
    // The v5 migration seeds quartzcore↔coreanimation, etc.
    const fromCanonical = db.getFrameworkSynonyms('coreanimation')
    expect(fromCanonical).toContain('quartzcore')
    const fromAlias = db.getFrameworkSynonyms('quartzcore')
    expect(fromAlias).toContain('coreanimation')
  })

  test('search.deleteBodyByDocId is a no-op when body table is absent', () => {
    expect(db.search.hasBodyFtsTable).toBe(true) // v6 creates it
    expect(() => db.search.deleteBodyByDocId(999_999)).not.toThrow()
  })
})
