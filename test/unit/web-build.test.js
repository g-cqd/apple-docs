import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { buildStaticSite } from '../../src/web/build.js'

let db
let tmpDir
let outDir
let ctx

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-build-'))
  outDir = join(tmpDir, 'web')

  // Seed a root
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')

  // Seed documents
  const now = new Date().toISOString()
  db.db.run(`INSERT INTO documents (source_type, key, title, kind, role, role_heading, framework, abstract_text, created_at, updated_at)
    VALUES ('apple-docc', 'documentation/swiftui/view', 'View', 'symbol', 'symbol', 'Protocol', 'swiftui', 'A type that represents part of your app UI', ?, ?)`, [now, now])
  db.db.run(`INSERT INTO documents (source_type, key, title, kind, role, role_heading, framework, abstract_text, created_at, updated_at)
    VALUES ('apple-docc', 'documentation/swiftui/text', 'Text', 'symbol', 'symbol', 'Structure', 'swiftui', 'A view that displays text', ?, ?)`, [now, now])

  // Seed sections
  const viewId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
  db.db.run(`INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order) VALUES (?, 'abstract', NULL, 'A type that represents part of your app UI', 0)`, [viewId])

  ctx = { db, dataDir: tmpDir, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildStaticSite (P7-D)', () => {
  test('creates output directory structure', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'assets'))).toBe(true)
    expect(existsSync(join(outDir, 'docs'))).toBe(true)
    expect(existsSync(join(outDir, 'data', 'search'))).toBe(true)
    expect(existsSync(join(outDir, 'worker'))).toBe(true)
  })

  test('creates index.html', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'index.html'))).toBe(true)
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('swiftui')
  })

  test('creates document pages at expected paths', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html'))).toBe(true)
    expect(existsSync(join(outDir, 'docs', 'documentation', 'swiftui', 'text', 'index.html'))).toBe(true)
  })

  test('document HTML contains the title', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const html = readFileSync(join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html'), 'utf8')
    expect(html).toContain('View')
    expect(html).toContain('<!DOCTYPE html>')
  })

  test('creates framework listing page', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'docs', 'swiftui', 'index.html'))).toBe(true)
  })

  test('creates manifest.json with correct counts', async () => {
    const _result = await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(outDir, 'manifest.json'), 'utf8'))
    expect(manifest.totalDocuments).toBe(2)
    expect(manifest.version).toBe(1)
    expect(manifest.buildDate).toBeTruthy()
  })

  test('generates search artifacts with hashed filenames', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    // search-manifest.json is always present (unhashed)
    expect(existsSync(join(outDir, 'data', 'search', 'search-manifest.json'))).toBe(true)
    // title-index and aliases now use content-hashed filenames
    const searchDir = join(outDir, 'data', 'search')
    const files = readdirSync(searchDir)
    expect(files.some(f => /^title-index\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
    expect(files.some(f => /^aliases\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
    // Manifest contains file mappings
    const manifest = JSON.parse(readFileSync(join(searchDir, 'search-manifest.json'), 'utf8'))
    expect(manifest.version).toBe(2)
    expect(manifest.files).toBeDefined()
    expect(manifest.files['title-index']).toMatch(/^title-index\.[0-9a-f]{10}\.json$/)
    expect(manifest.files['aliases']).toMatch(/^aliases\.[0-9a-f]{10}\.json$/)
  })

  test('generates framework metadata', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'data', 'frameworks', 'swiftui.json'))).toBe(true)
    const meta = JSON.parse(readFileSync(join(outDir, 'data', 'frameworks', 'swiftui.json'), 'utf8'))
    expect(meta.slug).toBe('swiftui')
    expect(meta.documentCount).toBe(2)
  })

  test('returns correct result shape', async () => {
    const result = await buildStaticSite({ out: outDir }, ctx)
    expect(result.pagesBuilt).toBe(2)
    expect(result.frameworksBuilt).toBe(1)
    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.outputDir).toBe(outDir)
    expect(result.searchArtifacts).toBeTruthy()
  })

  test('empty corpus produces valid minimal site', async () => {
    // Use fresh DB with no documents
    const emptyDb = new DocsDatabase(':memory:')
    const emptyCtx = { db: emptyDb, dataDir: tmpDir, logger: { info() {}, warn() {}, error() {} } }
    const result = await buildStaticSite({ out: outDir }, emptyCtx)
    expect(result.pagesBuilt).toBe(0)
    expect(existsSync(join(outDir, 'index.html'))).toBe(true)
    expect(existsSync(join(outDir, 'manifest.json'))).toBe(true)
    emptyDb.close()
  })

  test('copies CSS assets', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'assets', 'style.css'))).toBe(true)
  })
})
