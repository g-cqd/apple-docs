import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../../src/storage/database.js'
import { storageCompact } from '../../../src/commands/storage-compact.js'
import { search } from '../../../src/commands/search.js'
import { lookup } from '../../../src/commands/lookup.js'
import { setProfile, getProfile } from '../../../src/storage/profiles.js'

let db
let dataDir
let ctx
const KEY = 'documentation/swiftui/view'
const BODY = 'A SwiftUI view that represents part of your app user interface. '.repeat(50)

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-compact-'))
  ctx = { db, dataDir, logger: { info() {}, warn() {}, error() {}, debug() {} } }

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({ rootId: root.id, path: KEY, url: 'u', title: 'View', role: 'symbol', abstract: 'A view.' })
  db.upsertNormalizedDocument({
    document: { key: KEY, title: 'View', sourceType: 'apple-docc', framework: 'swiftui', role: 'symbol', abstractText: 'A view.' },
    sections: [
      { sectionKind: 'abstract', contentText: 'A view.', sortOrder: 0 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: BODY, sortOrder: 1 },
    ],
    relationships: [],
  })
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('storageCompact', () => {
  test('compresses sections, keeps reads correct, switches to raw-only', async () => {
    setProfile(db, 'balanced')
    const res = await storageCompact({}, ctx)

    expect(res.status).toBe('ok')
    expect(res.sectionsCompressed).toBeGreaterThanOrEqual(1)
    expect(getProfile(db)).toBe('raw-only')
    expect(db.getSnapshotMeta('sections_compressed')).toBe('1')

    // The large section is now stored as a BLOB (compressed) on disk…
    const raw = db.db.query("SELECT content_text FROM document_sections WHERE section_kind = 'discussion'").get()
    expect(typeof raw.content_text).not.toBe('string')

    // …but every reader decodes it transparently.
    const sections = db.getDocumentSections(KEY)
    expect(sections.find(s => s.sectionKind === 'discussion').contentText).toContain('part of your app user interface')

    const page = await lookup({ path: KEY }, ctx)
    expect(page.content).toContain('part of your app user interface')

    const r = await search({ query: 'View', noDeep: true }, ctx)
    expect(r.results.map(x => x.path)).toContain(KEY)
  })

  test('drops embedded raw payloads by default (DELETE, table kept)', async () => {
    const docId = db.db.query('SELECT id FROM documents WHERE key = ?').get(KEY).id
    db.upsertRawPayload(docId, '{"metadata":{"title":"View"}}')
    expect(db.getRawCount()).toBe(1)

    setProfile(db, 'balanced')
    const res = await storageCompact({}, ctx)
    expect(res.rawDropped).toBe(1)
    expect(db.getRawCount()).toBe(0)             // payloads gone
    expect(db.hasTable('document_raw')).toBe(true) // but the table stays (DELETE, not DROP)
  })

  test('--keep-raw retains the embedded raw payloads', async () => {
    const docId = db.db.query('SELECT id FROM documents WHERE key = ?').get(KEY).id
    db.upsertRawPayload(docId, '{"k":1}')

    setProfile(db, 'balanced')
    const res = await storageCompact({ keepRaw: true }, ctx)
    expect(res.rawDropped).toBe(0)
    expect(db.getRawCount()).toBe(1)
  })

  test('rebuilds documents_body_fts as contentless and body MATCH still works', async () => {
    setProfile(db, 'balanced')
    await storageCompact({}, ctx)

    const sql = db.db.query("SELECT sql FROM sqlite_master WHERE name = 'documents_body_fts'").get().sql
    expect(sql).toContain('contentless_delete')

    const hits = db.db.query("SELECT rowid FROM documents_body_fts WHERE documents_body_fts MATCH 'represents'").all()
    expect(hits.length).toBeGreaterThanOrEqual(1)
  })

  test('refuses a prebuilt install unless --force', async () => {
    setProfile(db, 'prebuilt')
    await expect(storageCompact({}, ctx)).rejects.toThrow(/prebuilt/i)

    const res = await storageCompact({ force: true }, ctx)
    expect(res.status).toBe('ok')
  })

  test('is idempotent — re-compacting keeps reads correct', async () => {
    setProfile(db, 'balanced')
    await storageCompact({}, ctx)
    const res2 = await storageCompact({}, ctx)
    expect(res2.status).toBe('ok')
    const sections = db.getDocumentSections(KEY)
    expect(sections.find(s => s.sectionKind === 'discussion').contentText).toContain('part of your app user interface')
  })
})
