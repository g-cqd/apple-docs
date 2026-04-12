import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

describe('DocsDatabase', () => {
  test('creates schema on init', () => {
    const row = db.db.query("SELECT value FROM schema_meta WHERE key = 'schema_version'").get()
    expect(row.value).toBe('4')
  })

  test('upsertRoot inserts and returns id', () => {
    const result = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-index')
    expect(result.id).toBeGreaterThan(0)
  })

  test('upsertRoot updates on conflict', () => {
    const r1 = db.upsertRoot('swiftui', 'SwiftUI', 'unknown', 'crawl')
    const r2 = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-index')
    expect(r1.id).toBe(r2.id)
    const root = db.getRootBySlug('swiftui')
    expect(root.kind).toBe('framework')
  })

  test('upsertPage inserts and FTS5 indexes it', () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'swiftui/view',
      url: 'https://developer.apple.com/tutorials/data/documentation/swiftui/view.json',
      title: 'View',
      role: 'symbol',
      roleHeading: 'Protocol',
      abstract: 'A type that represents part of your app user interface',
      declaration: 'protocol View',
    })

    // FTS5 should find it
    const results = db.searchPages('"View"*', 'View')
    expect(results.length).toBe(1)
    expect(results[0].title).toBe('View')
    expect(results[0].framework).toBe('SwiftUI')
  })

  test('searchPages filters by framework', () => {
    const r1 = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const r2 = db.upsertRoot('uikit', 'UIKit', 'framework', 'test')

    db.upsertPage({ rootId: r1.id, path: 'swiftui/view', url: 'u1', title: 'View', role: 'symbol', abstract: 'SwiftUI view protocol' })
    db.upsertPage({ rootId: r2.id, path: 'uikit/uiview', url: 'u2', title: 'UIView', role: 'symbol', abstract: 'UIKit view class' })

    const all = db.searchPages('"view"*', 'view')
    expect(all.length).toBe(2)

    const swiftOnly = db.searchPages('"view"*', 'view', { framework: 'swiftui' })
    expect(swiftOnly.length).toBe(1)
    expect(swiftOnly[0].path).toBe('swiftui/view')
  })

  test('FTS5 updates on page update', () => {
    const root = db.upsertRoot('test', 'Test', 'framework', 'test')
    db.upsertPage({ rootId: root.id, path: 'test/foo', url: 'u', title: 'OldTitle', role: 'symbol', abstract: 'old abstract' })

    // Update
    db.upsertPage({ rootId: root.id, path: 'test/foo', url: 'u', title: 'NewTitle', role: 'symbol', abstract: 'new abstract' })

    const old = db.searchPages('"OldTitle"*', 'OldTitle')
    expect(old.length).toBe(0)

    const fresh = db.searchPages('"NewTitle"*', 'NewTitle')
    expect(fresh.length).toBe(1)
  })

  test('getPage returns page with root info', () => {
    const root = db.upsertRoot('combine', 'Combine', 'framework', 'test')
    db.upsertPage({ rootId: root.id, path: 'combine/publisher', url: 'u', title: 'Publisher', role: 'symbol' })

    const page = db.getPage('combine/publisher')
    expect(page).not.toBeNull()
    expect(page.title).toBe('Publisher')
    expect(page.root_slug).toBe('combine')
    expect(page.framework).toBe('Combine')
  })

  test('crawl state operations', () => {
    db.seedCrawlIfNew('swiftui', 'swiftui', 0)
    db.seedCrawlIfNew('swiftui/view', 'swiftui', 1)

    const pending = db.getPendingCrawl('swiftui', 10)
    expect(pending.length).toBe(2)

    db.setCrawlState('swiftui', 'processed', 'swiftui', 0)

    const stats = db.getCrawlStats('swiftui')
    expect(stats.pending).toBe(1)
    expect(stats.processed).toBe(1)
  })

  test('seedCrawlIfNew does not overwrite existing', () => {
    db.seedCrawlIfNew('a/b', 'a', 0)
    db.setCrawlState('a/b', 'processed', 'a', 0)

    const added = db.seedCrawlIfNew('a/b', 'a', 0)
    expect(added).toBe(false)

    const stats = db.getCrawlStats('a')
    expect(stats.processed).toBe(1)
    expect(stats.pending).toBe(0)
  })

  test('refs operations', () => {
    const root = db.upsertRoot('test', 'Test', 'framework', 'test')
    const page = db.upsertPage({ rootId: root.id, path: 'test/a', url: 'u', title: 'A' })

    db.addRef(page.id, 'test/b', 'B', 'topics')
    db.addRef(page.id, 'test/c', 'C', 'seeAlso')

    const refs = db.getRefsBySource(page.id)
    expect(refs.length).toBe(2)

    db.deleteRefsBySource(page.id)
    expect(db.getRefsBySource(page.id).length).toBe(0)
  })

  test('getStats returns aggregate data', () => {
    const root = db.upsertRoot('test', 'Test', 'framework', 'test')
    db.upsertPage({ rootId: root.id, path: 'test/a', url: 'u', title: 'A' })
    db.upsertPage({ rootId: root.id, path: 'test/b', url: 'u', title: 'B' })

    const stats = db.getStats()
    expect(stats.totalPages).toBe(2)
    expect(stats.totalRoots).toBe(1)
  })
})
