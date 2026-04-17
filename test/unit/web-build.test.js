import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { buildStaticSite, minifyCSS } from '../../src/web/build.js'

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
    expect(manifest.files.aliases).toMatch(/^aliases\.[0-9a-f]{10}\.json$/)
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

  test('minifies CSS in output', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const css = readFileSync(join(outDir, 'assets', 'style.css'), 'utf8')
    // Minified CSS should not contain block comments or multi-newlines
    expect(css).not.toContain('/*')
    expect(css).not.toContain('\n\n')
  })

  test('creates bundled JS files', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'assets', 'core.js'))).toBe(true)
    expect(existsSync(join(outDir, 'assets', 'listing.js'))).toBe(true)
    // Core bundle should contain theme, search, and page-toc code
    const core = readFileSync(join(outDir, 'assets', 'core.js'), 'utf8')
    expect(core).toContain('apple-docs-theme') // from theme.js
    expect(core).toContain('search-input')     // from search.js
    expect(core).toContain('page-toc')         // from page-toc.js
    // Listing bundle should contain collection-filters and tree-view code
    const listing = readFileSync(join(outDir, 'assets', 'listing.js'), 'utf8')
    expect(listing).toContain('filter-chip')   // from collection-filters.js
    expect(listing).toContain('tree-data')     // from tree-view.js
  })

  test('bundled build references core.js in HTML', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const html = readFileSync(join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html'), 'utf8')
    expect(html.match(/core\.js/g)).toHaveLength(1)
    expect(html).not.toContain('search.js')
    expect(html).not.toContain('page-toc.js')
    expect(html).not.toContain('theme.js')
  })

  test('bundled framework listing references listing.js instead of per-feature scripts', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const html = readFileSync(join(outDir, 'docs', 'swiftui', 'index.html'), 'utf8')
    expect(html).toContain('listing.js')
    expect(html).not.toContain('collection-filters.js')
    expect(html).not.toContain('tree-view.js')
  })

  test('bundled search page references core.js once and keeps search-page.js standalone', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const html = readFileSync(join(outDir, 'search', 'index.html'), 'utf8')
    expect(html.match(/core\.js/g)).toHaveLength(1)
    expect(html).not.toContain('theme.js')
    expect(html).toContain('search-page.js')
  })

  test('bundled build does not emit duplicate per-file assets', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'assets', 'theme.js'))).toBe(false)
    expect(existsSync(join(outDir, 'assets', 'search.js'))).toBe(false)
    expect(existsSync(join(outDir, 'assets', 'page-toc.js'))).toBe(false)
    expect(existsSync(join(outDir, 'assets', 'collection-filters.js'))).toBe(false)
    expect(existsSync(join(outDir, 'assets', 'tree-view.js'))).toBe(false)
  })

  test('builds through a staging directory and cleans temp siblings after success', async () => {
    await buildStaticSite({ out: outDir }, ctx)

    const siblings = readdirSync(tmpDir)
    expect(siblings).toContain('web')
    expect(siblings.some(name => name.startsWith('web.tmp-'))).toBe(false)
    expect(siblings.some(name => name.startsWith('web.prev-'))).toBe(false)
  })

  test('preserves the existing output directory when a staged build fails', async () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'marker.txt'), 'keep me')

    const failingCtx = {
      db: {
        getRoots() {
          throw new Error('boom')
        },
      },
      dataDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    }

    await expect(buildStaticSite({ out: outDir }, failingCtx)).rejects.toThrow('boom')

    expect(readFileSync(join(outDir, 'marker.txt'), 'utf8')).toBe('keep me')
    const siblings = readdirSync(tmpDir)
    expect(siblings).toContain('web')
    expect(siblings.some(name => name.startsWith('web.tmp-'))).toBe(false)
    expect(siblings.some(name => name.startsWith('web.prev-'))).toBe(false)
  })

  test('restores the previous output if publish fails after moving it aside', async () => {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'marker.txt'), 'keep me')

    let renameCalls = 0
    const fsOps = {
      async rename(from, to) {
        renameCalls += 1
        if (renameCalls === 2) {
          throw new Error('publish failed')
        }
        return rename(from, to)
      },
      rm,
    }

    await expect(buildStaticSite({ out: outDir, fsOps }, ctx)).rejects.toThrow('publish failed')

    expect(readFileSync(join(outDir, 'marker.txt'), 'utf8')).toBe('keep me')
    const siblings = readdirSync(tmpDir)
    expect(siblings).toContain('web')
    expect(siblings.some(name => name.startsWith('web.tmp-'))).toBe(false)
  })
})

describe('minifyCSS', () => {
  test('strips block comments', () => {
    expect(minifyCSS('/* comment */ body { color: red; }')).not.toContain('comment')
  })

  test('collapses whitespace around syntax chars', () => {
    const result = minifyCSS('body {\n  color : red ;\n}')
    expect(result).toBe('body{color:red}')
  })

  test('removes trailing semicolons before closing brace', () => {
    expect(minifyCSS('a { color: red; }')).toBe('a{color:red}')
  })

  test('preserves values that contain spaces', () => {
    const result = minifyCSS('body { font-family: "Helvetica Neue", Arial; }')
    expect(result).toContain('"Helvetica Neue"')
  })
})
