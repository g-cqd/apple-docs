import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prune } from '../../../src/commands/prune.js'
import { keyPath } from '../../../src/lib/safe-path.js'
import { DocsDatabase } from '../../../src/storage/database.js'

let db
let dataDir
let ctx
const logger = { info() {}, warn() {}, error() {} }

function seedPage(root, path, title) {
  db.upsertPage({
    rootId: root.id,
    path,
    url: `https://example.test/${path}`,
    title,
    role: 'article',
    roleHeading: null,
    abstract: `${title} abstract`,
    platforms: null,
    declaration: null,
    etag: null,
    lastModified: null,
    contentHash: 'h',
    downloadedAt: new Date().toISOString(),
    sourceType: root.source_type,
  })
  const md = keyPath(dataDir, 'markdown', path, '.md')
  mkdirSync(join(md, '..'), { recursive: true })
  writeFileSync(md, `# ${title}`)
  const docId = db.db.query('SELECT id FROM documents WHERE key = ?').get(path).id
  db.db.run('INSERT INTO documents_body_fts(rowid, body) VALUES (?, ?)', [docId, `${title} body text`])
  return docId
}

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-prune-'))

  const swiftui = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'apple-docc')
  const combine = db.upsertRoot('combine', 'Combine', 'framework', 'apple-docc')
  const wwdc = db.upsertRoot('wwdc', 'WWDC', 'collection', 'wwdc')
  seedPage(swiftui, 'documentation/swiftui/view', 'View')
  seedPage(combine, 'documentation/combine/publisher', 'Publisher')
  seedPage(wwdc, 'wwdc/wwdc2025-101', 'Keynote')
  db.db.run(
    "INSERT INTO document_relationships (from_key, to_key, relation_type) VALUES ('documentation/combine/publisher', 'documentation/combine/subscriber', 'seeAlso')",
  )
  for (const slug of ['swiftui', 'combine', 'wwdc']) db.updateRootPageCount(slug)

  ctx = { db, dataDir, logger }
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

function writeScope(obj) {
  writeFileSync(join(dataDir, 'scope.json'), JSON.stringify(obj))
}

describe('prune', () => {
  test('refuses to run without scope.json', async () => {
    await expect(prune({}, ctx)).rejects.toThrow(/scope\.json/)
  })

  test('unknown apple-docc framework slug errors and lists known slugs', async () => {
    writeScope({ version: 1, appleDoccFrameworks: ['swfitui'] })
    await expect(prune({}, ctx)).rejects.toThrow(/swfitui.*swiftui/s)
  })

  test('dry-run reports the doomed set and deletes nothing', async () => {
    writeScope({ version: 1, sources: ['apple-docc'], appleDoccFrameworks: ['swiftui'] })
    const r = await prune({ dryRun: true }, ctx)
    expect(r.status).toBe('dry-run')
    expect(r.rootsRemoved).toBe(2)
    expect(r.pagesRemoved).toBe(2)
    expect(db.getRoots().length).toBe(3)
    expect(db.db.query('SELECT COUNT(*) AS c FROM pages').get().c).toBe(3)
  })

  test('removes out-of-scope roots, pages, documents, FTS rows, files, relationships', async () => {
    writeScope({ version: 1, sources: ['apple-docc'], appleDoccFrameworks: ['swiftui'] })
    const r = await prune({ noVacuum: true }, ctx)
    expect(r.status).toBe('ok')
    expect(r.rootsRemoved).toBe(2)
    expect(r.pagesRemoved).toBe(2)
    expect(r.documentsRemoved).toBe(2)

    expect(db.getRoots().map((x) => x.slug)).toEqual(['swiftui'])
    expect(
      db.db
        .query('SELECT path FROM pages')
        .all()
        .map((x) => x.path),
    ).toEqual(['documentation/swiftui/view'])
    expect(
      db.db
        .query('SELECT key FROM documents')
        .all()
        .map((x) => x.key),
    ).toEqual(['documentation/swiftui/view'])
    // Title FTS cleaned by the documents_ad trigger; body FTS manually.
    expect(db.db.query("SELECT COUNT(*) AS c FROM documents_fts WHERE documents_fts MATCH 'publisher'").get().c).toBe(0)
    expect(db.db.query("SELECT COUNT(*) AS c FROM documents_body_fts WHERE documents_body_fts MATCH 'publisher'").get().c).toBe(0)
    expect(db.db.query("SELECT COUNT(*) AS c FROM documents_body_fts WHERE documents_body_fts MATCH 'view'").get().c).toBe(1)
    expect(db.db.query('SELECT COUNT(*) AS c FROM document_relationships').get().c).toBe(0)

    expect(existsSync(keyPath(dataDir, 'markdown', 'documentation/swiftui/view', '.md'))).toBe(true)
    expect(existsSync(keyPath(dataDir, 'markdown', 'documentation/combine/publisher', '.md'))).toBe(false)
    expect(existsSync(keyPath(dataDir, 'markdown', 'wwdc/wwdc2025-101', '.md'))).toBe(false)
  })

  test('is idempotent: a second run removes nothing', async () => {
    writeScope({ version: 1, sources: ['apple-docc'], appleDoccFrameworks: ['swiftui'] })
    await prune({ noVacuum: true }, ctx)
    const again = await prune({ noVacuum: true }, ctx)
    expect(again.rootsRemoved).toBe(0)
    expect(again.pagesRemoved).toBe(0)
  })

  test('keepSymbols=false drops the symbol catalog, renders, and resources dir', async () => {
    db.upsertSfSymbol({ name: 'pencil', scope: 'public', categories: ['editing'], keywords: ['write'], orderIndex: 0 })
    mkdirSync(join(dataDir, 'resources', 'symbols'), { recursive: true })
    writeFileSync(join(dataDir, 'resources', 'symbols', 'x.svg'), '<svg/>')
    writeScope({ version: 1, keepSymbols: false })
    const r = await prune({ noVacuum: true }, ctx)
    expect(r.symbolsDropped).toBe(true)
    expect(r.rootsRemoved).toBe(0) // no source restriction → all roots stay
    expect(db.db.query('SELECT COUNT(*) AS c FROM sf_symbols').get().c).toBe(0)
    expect(existsSync(join(dataDir, 'resources', 'symbols'))).toBe(false)
  })

  test('keepFonts=false drops the font catalog and resources dir', async () => {
    db.upsertAppleFontFamily({ id: 'sf-pro', displayName: 'SF Pro', status: 'available' })
    mkdirSync(join(dataDir, 'resources', 'fonts'), { recursive: true })
    writeScope({ version: 1, keepFonts: false })
    const r = await prune({ noVacuum: true }, ctx)
    expect(r.fontsDropped).toBe(true)
    expect(db.db.query('SELECT COUNT(*) AS c FROM apple_font_families').get().c).toBe(0)
    expect(existsSync(join(dataDir, 'resources', 'fonts'))).toBe(false)
  })
})
