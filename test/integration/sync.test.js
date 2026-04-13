import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { normalize } from '../../src/content/normalize.js'
import { persistFetchedDocPage } from '../../src/pipeline/persist.js'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync } from 'node:fs'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

let db
let tmpDir

beforeAll(() => {
  tmpDir = join(import.meta.dir, '..', '.tmp-integration-sync')
  mkdirSync(join(tmpDir, 'raw-json'), { recursive: true })
  mkdirSync(join(tmpDir, 'markdown'), { recursive: true })

  db = new DocsDatabase(':memory:')

  // Seed a root
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
})

afterAll(() => {
  db.close()
  try { rmSync(tmpDir, { recursive: true }) } catch {}
})

describe('Integration: Sync Pipeline', () => {
  test('persistFetchedDocPage populates pages + documents + sections', async () => {
    const root = db.getRootBySlug('swiftui')

    await persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
      etag: '"test-etag"',
      lastModified: 'Sat, 01 Jan 2026 00:00:00 GMT',
    })

    // Verify pages table populated
    const page = db.getPage('swiftui/view')
    expect(page).not.toBeNull()
    expect(page.title).toBe('View')

    // Verify documents table populated
    const doc = db.db.query('SELECT * FROM documents WHERE key = ?').get('swiftui/view')
    expect(doc).not.toBeNull()
    expect(doc.title).toBe('View')
    expect(doc.source_type).toBe('apple-docc')
    expect(doc.framework).toBe('swiftui')

    // Verify document_sections populated
    const sections = db.getDocumentSections('swiftui/view')
    expect(sections.length).toBeGreaterThan(0)
    const sectionKinds = sections.map(s => s.sectionKind ?? s.section_kind)
    expect(sectionKinds).toContain('abstract')

    // Verify raw JSON written to disk
    expect(existsSync(join(tmpDir, 'raw-json', 'swiftui', 'view.json'))).toBe(true)

    // Verify markdown written to disk
    expect(existsSync(join(tmpDir, 'markdown', 'swiftui', 'view.md'))).toBe(true)
  })

  test('documents_fts is searchable after persist', () => {
    const results = db.searchPages('"View"*', 'View')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0].title).toBe('View')
  })

  test('document_relationships populated for topic children', () => {
    const rels = db.db.query(
      'SELECT to_key, relation_type FROM document_relationships WHERE from_key = ?'
    ).all('swiftui/view')

    expect(rels.length).toBeGreaterThan(0)
    // Should have child relations from topics
    const childRels = rels.filter(r => r.relation_type === 'child')
    expect(childRels.length).toBeGreaterThan(0)
  })

  test('normalize produces consistent results for same input', () => {
    const result1 = normalize(fixture, 'swiftui/view', 'apple-docc')
    const result2 = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(result1.document.title).toBe(result2.document.title)
    expect(result1.sections.length).toBe(result2.sections.length)
    expect(result1.relationships.length).toBe(result2.relationships.length)
  })

  test('re-persisting same page updates without duplication', async () => {
    const root = db.getRootBySlug('swiftui')

    // Persist again
    await persistFetchedDocPage({
      db,
      dataDir: tmpDir,
      rootId: root.id,
      path: 'swiftui/view',
      sourceType: 'apple-docc',
      json: fixture,
      etag: '"test-etag-v2"',
      lastModified: 'Sun, 02 Jan 2026 00:00:00 GMT',
    })

    // Should still have exactly 1 document row
    const count = db.db.query('SELECT COUNT(*) as c FROM documents WHERE key = ?').get('swiftui/view')
    expect(count.c).toBe(1)

    // Sections should be replaced (not duplicated)
    const sections = db.getDocumentSections('swiftui/view')
    const abstractSections = sections.filter(s => (s.sectionKind ?? s.section_kind) === 'abstract')
    expect(abstractSections.length).toBeLessThanOrEqual(1)
  })
})
