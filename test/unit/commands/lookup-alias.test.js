import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../../src/storage/database.js'
import { lookup } from '../../../src/commands/lookup.js'

let db
let dataDir
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-lookup-alias-'))
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
  // Production apple-docc keys are stored WITHOUT the documentation/ prefix.
  db.upsertPage({
    rootId: root.id,
    path: 'swiftui/text',
    url: 'https://developer.apple.com/documentation/swiftui/text',
    title: 'Text',
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: 'A view that displays one or more lines of read-only text.',
    declaration: 'struct Text',
  })
  const docId = db.db.query("SELECT id FROM documents WHERE key = 'swiftui/text'").get().id
  db.db.run(
    `INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
     VALUES (?, 'abstract', NULL, 'A view that displays one or more lines of read-only text.', 0)`,
    [docId],
  )
  ctx = { db, dataDir, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('lookup path aliases', () => {
  test('canonical key resolves', async () => {
    const r = await lookup({ path: 'swiftui/text' }, ctx)
    expect(r.found).toBe(true)
    expect(r.metadata.title).toBe('Text')
  })

  test('documentation/-prefixed spelling resolves to the same page', async () => {
    const r = await lookup({ path: 'documentation/swiftui/text' }, ctx)
    expect(r.found).toBe(true)
    expect(r.metadata.path).toBe('swiftui/text')
  })

  test('/documentation/ and doc:// spellings resolve too', async () => {
    const slash = await lookup({ path: '/documentation/swiftui/text' }, ctx)
    expect(slash.found).toBe(true)
    const uri = await lookup({ path: 'doc://com.apple.SwiftUI/documentation/swiftui/text' }, ctx)
    expect(uri.found).toBe(true)
  })

  test('a genuinely unknown path still reports not found', async () => {
    const r = await lookup({ path: 'documentation/swiftui/nope' }, ctx)
    expect(r.found).toBe(false)
  })
})
