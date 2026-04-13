import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { lookup } from '../../src/commands/lookup.js'
import { setProfile } from '../../src/storage/profiles.js'
import { readText } from '../../src/storage/files.js'

let db, dataDir, ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-lookup-'))

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app UI',
    declaration: 'protocol View',
  })

  // upsertPage triggers a row in documents via schema triggers, so use the existing one
  const docId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
  db.db.run(`INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order) VALUES (?, 'abstract', NULL, 'A type that represents part of your app UI', 0)`, [docId])

  ctx = { db, dataDir, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('Lookup cache (P8-D)', () => {
  test('balanced profile caches rendered markdown on read', async () => {
    setProfile(db, 'balanced')
    const result = await lookup({ path: 'documentation/swiftui/view' }, ctx)
    expect(result.found).toBe(true)
    expect(result.content).toBeTruthy()

    const mdPath = join(dataDir, 'markdown', 'documentation/swiftui/view.md')
    expect(existsSync(mdPath)).toBe(true)
    const cached = await readText(mdPath)
    expect(cached).toContain('View')
  })

  test('subsequent lookup reads from cache', async () => {
    setProfile(db, 'balanced')
    const r1 = await lookup({ path: 'documentation/swiftui/view' }, ctx)
    const r2 = await lookup({ path: 'documentation/swiftui/view' }, ctx)
    expect(r1.content).toBeTruthy()
    expect(r2.content).toBeTruthy()
    // Second lookup reads from cache (no fallback note)
    expect(r2.note).toBeUndefined()
  })

  test('raw-only profile does NOT cache', async () => {
    setProfile(db, 'raw-only')
    await lookup({ path: 'documentation/swiftui/view' }, ctx)

    const mdPath = join(dataDir, 'markdown', 'documentation/swiftui/view.md')
    expect(existsSync(mdPath)).toBe(false)
  })

  test('noCache option skips caching even on balanced', async () => {
    setProfile(db, 'balanced')
    await lookup({ path: 'documentation/swiftui/view', noCache: true }, ctx)

    const mdPath = join(dataDir, 'markdown', 'documentation/swiftui/view.md')
    expect(existsSync(mdPath)).toBe(false)
  })

  test('lookup still works for not-found path', async () => {
    const result = await lookup({ path: 'nonexistent/path' }, ctx)
    expect(result.found).toBe(false)
  })
})
