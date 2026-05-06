import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database as SqliteDatabase } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
    expect(row.value).toBe('12')
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

  test('getPageByPath returns the active page row when normalized documents exist', () => {
    const root = db.upsertRoot('combine', 'Combine', 'framework', 'test')
    db.upsertPage({ rootId: root.id, path: 'combine/publisher', url: 'u', title: 'Publisher', role: 'symbol' })
    db.upsertNormalizedDocument({
      document: {
        key: 'combine/publisher',
        title: 'Publisher',
        sourceType: 'apple-docc',
        framework: 'combine',
        role: 'symbol',
      },
      sections: [],
      relationships: [],
    })

    const page = db.getPageByPath('combine/publisher')
    expect(page).not.toBeNull()
    expect(page.title).toBe('Publisher')
    expect(page.root_slug).toBe('combine')
    expect(page.status).toBe('active')
    expect(page.root_id).toBe(root.id)
  })

  test('getPagesByRole returns normalized-document hits when available', () => {
    const root = db.upsertRoot('accelerate', 'Accelerate', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'accelerate/adding-a-bokeh-effect-to-images',
      url: 'u',
      title: 'Adding a bokeh effect to images',
      role: 'sampleCode',
      sourceType: 'apple-docc',
    })

    const pages = db.getPagesByRole('sampleCode')
    expect(pages.some(page => page.key === 'accelerate/adding-a-bokeh-effect-to-images')).toBe(true)
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

  test('schema v8 keeps source metadata, normalized tables, and sync checkpoints available', () => {
    // Check roots has source_type column
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const rootRow = db.db.query('SELECT source_type FROM roots WHERE slug = ?').get('swiftui')
    expect(rootRow.source_type).toBe('apple-docc')

    // Check pages has new columns
    db.upsertPage({ rootId: root.id, path: 'swiftui/view', url: 'u', title: 'View', role: 'symbol' })
    const pageRow = db.db.query('SELECT source_type, language, is_release_notes, url_depth FROM pages WHERE path = ?').get('swiftui/view')
    expect(pageRow.source_type).toBe('apple-docc')
    expect(pageRow.is_release_notes).toBe(0)

    // Check framework_synonyms table exists and has seed data
    const synonym = db.db.query('SELECT canonical FROM framework_synonyms WHERE alias = ?').get('coreanimation')
    expect(synonym).not.toBeNull()
    expect(synonym.canonical).toBe('quartzcore')

    // New normalized tables should mirror page inserts
    const documentRow = db.db.query('SELECT key, title FROM documents WHERE key = ?').get('swiftui/view')
    expect(documentRow).not.toBeNull()
    expect(documentRow.title).toBe('View')

    const designRoot = db.upsertRoot('design', 'Human Interface Guidelines', 'design', 'test')
    const designRow = db.db.query('SELECT source_type FROM roots WHERE id = ?').get(designRoot.id)
    expect(designRow.source_type).toBe('hig')

    const guidelinesRoot = db.upsertRoot('app-store-review', 'App Store Review Guidelines', 'guidelines', 'test')
    const guidelinesRow = db.db.query('SELECT source_type FROM roots WHERE id = ?').get(guidelinesRoot.id)
    expect(guidelinesRow.source_type).toBe('guidelines')

    const sampleCodeRoot = db.upsertRoot('sample-code', 'Apple Sample Code', 'collection', 'test')
    const sampleCodeRow = db.db.query('SELECT source_type FROM roots WHERE id = ?').get(sampleCodeRoot.id)
    expect(sampleCodeRow.source_type).toBe('sample-code')

    const packagesRoot = db.upsertRoot('packages', 'Swift Package Catalog', 'collection', 'test')
    const packagesRow = db.db.query('SELECT source_type FROM roots WHERE id = ?').get(packagesRoot.id)
    expect(packagesRow.source_type).toBe('packages')

    expect(db.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sync_checkpoint'").get()).toBeTruthy()
  })

  test('tx commits writes and returns the callback result', () => {
    const rootId = db.tx(() => db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test').id)

    expect(rootId).toBeGreaterThan(0)
    expect(db.getRootBySlug('swiftui')).not.toBeNull()
  })

  test('tx rolls back writes when the callback throws', () => {
    expect(() => db.tx(() => {
      db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
      throw new Error('boom')
    })).toThrow('boom')

    expect(db.getRootBySlug('swiftui')).toBeNull()
  })

  test('getActivePathsIn batches large key lists and only returns active paths', () => {
    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    const keys = Array.from({ length: 905 }, (_, index) => `swiftui/item-${index}`)

    for (const key of [keys[0], keys[450], keys[904]]) {
      db.upsertPage({
        rootId: root.id,
        path: key,
        url: `https://developer.apple.com/documentation/${key}`,
        title: key,
        role: 'symbol',
      })
    }
    db.markPageDeleted(keys[450])

    const activePaths = db.getActivePathsIn(keys)

    expect(activePaths.has(keys[0])).toBe(true)
    expect(activePaths.has(keys[450])).toBe(false)
    expect(activePaths.has(keys[904])).toBe(true)
    expect(activePaths.size).toBe(2)
  })

  test('migrates legacy flat-source roots out of apple-docc on open', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'apple-docs-db-'))
    const dbPath = join(tempDir, 'apple-docs.db')
    const seeded = new DocsDatabase(dbPath)
    const root = seeded.upsertRoot('sample-code', 'Apple Sample Code', 'collection', 'sample-code')
    seeded.upsertPage({
      rootId: root.id,
      path: 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
      url: 'https://developer.apple.com/documentation/swiftui/food-truck-building-a-swiftui-multiplatform-app',
      title: 'Food Truck',
      sourceType: 'sample-code',
    })
    seeded.upsertNormalizedDocument({
      document: {
        key: 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
        title: 'Food Truck',
        sourceType: 'sample-code',
        framework: 'sample-code',
      },
      sections: [],
      relationships: [],
    })
    seeded.close()

    const legacy = new SqliteDatabase(dbPath)
    try {
      legacy.run("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'")
      legacy.run("UPDATE roots SET source_type = 'apple-docc' WHERE slug = 'sample-code'")
      legacy.run("UPDATE pages SET source_type = 'apple-docc' WHERE path = 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app'")
      legacy.run("UPDATE documents SET source_type = 'apple-docc' WHERE key = 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app'")
    } finally {
      legacy.close()
    }

    const migrated = new DocsDatabase(dbPath)
    try {
      expect(migrated.getRootBySlug('sample-code').source_type).toBe('sample-code')
      expect(migrated.db.query('SELECT source_type FROM pages WHERE path = ?').get('sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app').source_type).toBe('sample-code')
      expect(migrated.db.query('SELECT source_type FROM documents WHERE key = ?').get('sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app').source_type).toBe('sample-code')
    } finally {
      migrated.close()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('getFrameworkSynonyms returns bidirectional aliases', () => {
    const aliases = db.getFrameworkSynonyms('quartzcore')
    expect(aliases).toContain('coreanimation')

    const reverse = db.getFrameworkSynonyms('coreanimation')
    expect(reverse).toContain('quartzcore')
  })

  test('getFrameworkSynonyms returns empty array for unknown framework', () => {
    expect(db.getFrameworkSynonyms('nonexistent')).toEqual([])
    expect(db.getFrameworkSynonyms(null)).toEqual([])
  })

  test('upsertNormalizedDocument stores sections and relationships', () => {
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: 'swiftui/view',
        title: 'View',
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Protocol',
        framework: 'swiftui',
        url: 'https://developer.apple.com/documentation/swiftui/view',
        abstractText: 'A view.',
        declarationText: 'protocol View',
      },
      sections: [
        {
          sectionKind: 'discussion',
          heading: 'Overview',
          contentText: 'Overview text',
          contentJson: null,
          sortOrder: 0,
        },
      ],
      relationships: [
        {
          fromKey: 'swiftui/view',
          toKey: 'swiftui/text',
          relationType: 'see_also',
          section: 'See Also',
          sortOrder: 0,
        },
      ],
    }, {
      contentHash: 'normalized-hash',
      rawPayloadHash: 'raw-hash',
    })

    const sections = db.getDocumentSections('swiftui/view')
    expect(sections.length).toBe(1)
    expect(sections[0].heading).toBe('Overview')

    const relationship = db.db.query('SELECT to_key, relation_type FROM document_relationships WHERE from_key = ?').get('swiftui/view')
    expect(relationship.to_key).toBe('swiftui/text')
    expect(relationship.relation_type).toBe('see_also')
  })

  test('getSnapshotMeta returns null for missing key', () => {
    expect(db.getSnapshotMeta('nonexistent')).toBeNull()
  })

  test('setSnapshotMeta + getSnapshotMeta round-trips', () => {
    db.setSnapshotMeta('snapshot_tier', 'standard')
    expect(db.getSnapshotMeta('snapshot_tier')).toBe('standard')
  })

  test('setSnapshotMeta overwrites existing value', () => {
    db.setSnapshotMeta('snapshot_tier', 'lite')
    db.setSnapshotMeta('snapshot_tier', 'full')
    expect(db.getSnapshotMeta('snapshot_tier')).toBe('full')
  })

  test('setSyncCheckpoint + getSyncCheckpoint round-trips structured values', () => {
    db.setSyncCheckpoint('body-index:full', { indexed: 12, lastDocumentId: 99 })
    expect(db.getSyncCheckpoint('body-index:full')).toEqual({ indexed: 12, lastDocumentId: 99 })
  })

  test('clearSyncCheckpoint removes saved checkpoint state', () => {
    db.setSyncCheckpoint('body-index:full', { indexed: 12 })
    db.clearSyncCheckpoint('body-index:full')
    expect(db.getSyncCheckpoint('body-index:full')).toBeNull()
  })

  test('getTier prefers snapshot_meta when present', () => {
    db.setSnapshotMeta('snapshot_tier', 'full')
    expect(db.getTier()).toBe('full')
  })

  test('getTier falls back to lite when document_sections table is absent', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'apple-docs-db-tier-'))
    const dbPath = join(tempDir, 'apple-docs.db')
    const seeded = new DocsDatabase(dbPath)
    try {
      seeded.db.run('DROP TABLE document_sections')
      seeded.close()

      const reopened = new DocsDatabase(dbPath)
      try {
        expect(reopened.getTier()).toBe('lite')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('getSchemaVersion returns current schema version', () => {
    expect(db.getSchemaVersion()).toBe(12)
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
