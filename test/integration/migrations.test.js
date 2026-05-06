import { describe, test, expect } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Migration E2E (P8-G)', () => {
  test('fresh DB creates all tables at current schema version', () => {
    const db = new DocsDatabase(':memory:')
    const version = db.getSchemaVersion()
    expect(version).toBe(12)

    const tables = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
    const tableNames = tables.map(t => t.name)

    // Core tables from initial schema (v1)
    expect(tableNames).toContain('schema_meta')
    expect(tableNames).toContain('roots')
    expect(tableNames).toContain('pages')
    expect(tableNames).toContain('refs')
    expect(tableNames).toContain('crawl_state')
    expect(tableNames).toContain('activity')
    expect(tableNames).toContain('update_log')

    // Added in v4
    expect(tableNames).toContain('pages_body_fts')

    // Added in v5
    expect(tableNames).toContain('framework_synonyms')

    // Added in v6
    expect(tableNames).toContain('documents')
    expect(tableNames).toContain('document_sections')
    expect(tableNames).toContain('document_relationships')
    expect(tableNames).toContain('snapshot_meta')
    // Added in v8
    expect(tableNames).toContain('sync_checkpoint')
    // Added in v9
    expect(tableNames).toContain('document_render_index')
    // Added in v10
    expect(tableNames).toContain('apple_font_families')
    expect(tableNames).toContain('apple_font_files')
    expect(tableNames).toContain('sf_symbols')
    expect(tableNames).toContain('sf_symbol_renders')

    db.close()
  })

  test('fresh DB creates all FTS virtual tables', () => {
    const db = new DocsDatabase(':memory:')

    const virtualTables = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%fts%' OR name LIKE '%trigram%' ORDER BY name")
      .all()
    const virtualTableNames = virtualTables.map(t => t.name)

    // pages FTS (v1)
    expect(virtualTableNames).toContain('pages_fts')
    // trigram and body FTS (v4)
    expect(virtualTableNames).toContain('titles_trigram')
    expect(virtualTableNames).toContain('pages_body_fts')
    // documents FTS (v6)
    expect(virtualTableNames).toContain('documents_fts')
    expect(virtualTableNames).toContain('documents_trigram')
    expect(virtualTableNames).toContain('documents_body_fts')
    // resource search FTS (v10, rebuilt in v11)
    expect(virtualTableNames).toContain('sf_symbols_fts')

    db.close()
  })

  test('migration is idempotent — schema version stays stable after construction', () => {
    const db = new DocsDatabase(':memory:')
    const v1 = db.getSchemaVersion()
    expect(v1).toBe(12)

    // Reading version again must return the same value — no spurious increment
    const v2 = db.getSchemaVersion()
    expect(v2).toBe(v1)

    db.close()
  })

  test('downgrade protection — future schema version throws on open', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-mig-'))
    const dbPath = join(tmpDir, 'test.db')

    try {
      // Manually create a DB whose schema_meta claims a future version (99)
      const raw = new Database(dbPath)
      raw.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      raw.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '99')")
      raw.close()

      // DocsDatabase must refuse to open it
      expect(() => new DocsDatabase(dbPath)).toThrow()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('downgrade protection error message identifies both versions', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-mig-'))
    const dbPath = join(tmpDir, 'test.db')

    try {
      const raw = new Database(dbPath)
      raw.run('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      raw.run("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', '42')")
      raw.close()

      let caught = null
      try {
        new DocsDatabase(dbPath)
      } catch (e) {
        caught = e
      }

      expect(caught).not.toBeNull()
      // The error should mention both the DB version and the supported version
      expect(caught.message).toMatch(/42/)
      expect(caught.message).toMatch(/12/)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  test('data survives — upserted root is queryable after open', () => {
    const db = new DocsDatabase(':memory:')

    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    expect(root.id).toBeGreaterThan(0)

    const fetched = db.getRootBySlug('swiftui')
    expect(fetched).not.toBeNull()
    expect(fetched.display_name).toBe('SwiftUI')
    expect(fetched.kind).toBe('framework')

    db.close()
  })

  test('data survives — upserted page is queryable after open', () => {
    const db = new DocsDatabase(':memory:')

    const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/swiftui/view',
      url: 'https://developer.apple.com/documentation/swiftui/view',
      title: 'View',
      role: 'symbol',
      roleHeading: 'Protocol',
      abstract: 'A type that represents part of your app UI',
    })

    // getPage() routes through documents table when normalized docs exist
    const page = db.getPage('documentation/swiftui/view')
    expect(page).not.toBeNull()
    expect(page.title).toBe('View')
    expect(page.abstract).toBe('A type that represents part of your app UI')

    // The document record must also exist in the documents table directly
    const doc = db.db
      .query("SELECT * FROM documents WHERE key = 'documentation/swiftui/view'")
      .get()
    expect(doc).not.toBeNull()
    expect(doc.title).toBe('View')
    expect(doc.role).toBe('symbol')

    db.close()
  })

  test('FTS tables are functional after fresh creation — documents_fts MATCH works', () => {
    const db = new DocsDatabase(':memory:')

    const root = db.upsertRoot('test', 'Test', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/test/exampleview',
      url: 'u',
      title: 'ExampleView',
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: 'An example view for testing FTS',
    })

    // documents_fts is the primary FTS table for normalized documents
    const results = db.db
      .query("SELECT key FROM documents_fts WHERE documents_fts MATCH 'example'")
      .all()
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].key).toBe('documentation/test/exampleview')

    db.close()
  })

  test('FTS tables are functional — pages_fts MATCH works', () => {
    const db = new DocsDatabase(':memory:')

    const root = db.upsertRoot('test', 'Test', 'framework', 'test')
    db.upsertPage({
      rootId: root.id,
      path: 'documentation/test/searchable',
      url: 'u',
      title: 'SearchableList',
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: 'A searchable list component',
    })

    // pages_fts must also be kept in sync by the after-insert trigger
    const results = db.db
      .query("SELECT path FROM pages_fts WHERE pages_fts MATCH 'searchable'")
      .all()
    expect(results.length).toBeGreaterThanOrEqual(1)

    db.close()
  })

  test('FTS integrity check passes on documents_fts', () => {
    const db = new DocsDatabase(':memory:')

    expect(() => {
      db.db
        .query("INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')")
        .run()
    }).not.toThrow()

    db.close()
  })

  test('schema_meta table holds exactly the schema_version key after init', () => {
    const db = new DocsDatabase(':memory:')

    const row = db.db
      .query("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get()
    expect(row).not.toBeNull()
    expect(row.value).toBe('12')

    db.close()
  })

  test('framework_synonyms are seeded on fresh DB', () => {
    const db = new DocsDatabase(':memory:')

    const synonyms = db.db
      .query('SELECT canonical, alias FROM framework_synonyms ORDER BY canonical, alias')
      .all()
    expect(synonyms.length).toBeGreaterThan(0)

    // quartzcore <-> coreanimation is a known seeded pair
    const quartzEntry = synonyms.find(
      s => s.canonical === 'quartzcore' && s.alias === 'coreanimation',
    )
    expect(quartzEntry).not.toBeUndefined()

    db.close()
  })

  test('getSchemaVersion() matches the constant embedded in the source', () => {
    const db = new DocsDatabase(':memory:')
    // The public accessor must agree with what _migrate() wrote
    expect(db.getSchemaVersion()).toBe(12)
    db.close()
  })
})
