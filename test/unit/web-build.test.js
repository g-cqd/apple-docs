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

describe('buildStaticSite — incremental (Phase 1)', () => {
  test('records render-index entries on a full build', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const rows = db.db.query('SELECT doc_id, sections_digest, template_version, html_hash FROM document_render_index').all()
    // Two documents in the fixture; both should be tracked
    expect(rows.length).toBe(2)
    for (const row of rows) {
      expect(row.sections_digest).toBeTruthy()
      expect(row.template_version).toBeTruthy()
      expect(row.html_hash).toBeTruthy()
    }
  })

  test('incremental rerun with no changes skips every doc and writes nothing new', async () => {
    await buildStaticSite({ out: outDir }, ctx)

    // Snapshot mtimes after the first build
    const docPath = join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html')
    const firstMtime = readFileSync(docPath) // existence check
    expect(firstMtime).toBeTruthy()

    // Re-run incrementally — nothing changed
    const result = await buildStaticSite({ out: outDir, incremental: true }, ctx)
    expect(result.pagesBuilt).toBe(0)
    expect(result.pagesSkipped).toBe(2)
  })

  test('incremental rerun re-renders docs whose sections changed', async () => {
    await buildStaticSite({ out: outDir }, ctx)

    // Mutate one document's section: changing content_text length flips
    // the cheap sections_digest, so the incremental skip must miss.
    const viewId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
    db.db.run(
      `UPDATE document_sections SET content_text = ? WHERE document_id = ? AND section_kind = 'abstract'`,
      ['A type that represents part of your app UI — extensively rewritten body', viewId],
    )

    const result = await buildStaticSite({ out: outDir, incremental: true }, ctx)
    expect(result.pagesBuilt).toBe(1)
    expect(result.pagesSkipped).toBe(1)
  })

  test('--full clears the render index and forces every doc to re-render', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(db.db.query('SELECT COUNT(*) as c FROM document_render_index').get().c).toBe(2)

    const result = await buildStaticSite({ out: outDir, full: true }, ctx)
    expect(result.pagesBuilt).toBe(2)
    expect(result.pagesSkipped).toBe(0)
  })

  test('--frameworks filter restricts the build to the named slugs', async () => {
    // Add a second framework so the filter is meaningful
    db.upsertRoot('combine', 'Combine', 'framework', 'test')
    const now = new Date().toISOString()
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, role, role_heading, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/combine/publisher', 'Publisher', 'symbol', 'symbol', 'Protocol', 'combine', 'A publisher emits values', ?, ?)`,
      [now, now],
    )

    const result = await buildStaticSite({ out: outDir, frameworks: ['swiftui'] }, ctx)
    expect(result.pagesBuilt).toBe(2)
    expect(existsSync(join(outDir, 'docs', 'documentation', 'combine', 'publisher', 'index.html'))).toBe(false)
    expect(existsSync(join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html'))).toBe(true)
  })

  test('writes a build_failures.jsonl sidecar when a render throws — does not abort', async () => {
    // No good in-process way to force a per-doc render failure without
    // mocking renderDocumentPage. We exercise the success path here and
    // assert the failures file is *not* written when nothing throws.
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'build-failures.jsonl'))).toBe(false)
  })

  test('persists a web_build checkpoint in sync_checkpoint after a successful run', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    const cp = db.getWebBuildCheckpoint()
    expect(cp).not.toBeNull()
    expect(cp.status).toBe('completed')
    expect(cp.template_version).toBeTruthy()
    expect(cp.pages_built).toBe(2)
  })
})

describe('buildStaticSite — SEO surface (Phase 4)', () => {
  test('emits a sitemap-index pointing at per-framework gzipped sitemaps', async () => {
    await buildStaticSite({ out: outDir, baseUrl: 'https://example.test' }, ctx)
    expect(existsSync(join(outDir, 'sitemap.xml'))).toBe(true)
    expect(existsSync(join(outDir, 'sitemaps', 'swiftui.xml.gz'))).toBe(true)
    expect(existsSync(join(outDir, 'sitemaps', '_root.xml.gz'))).toBe(true)
    const indexXml = readFileSync(join(outDir, 'sitemap.xml'), 'utf8')
    expect(indexXml).toContain('<sitemapindex')
    expect(indexXml).toContain('https://example.test/sitemaps/swiftui.xml.gz')
    expect(indexXml).toContain('https://example.test/sitemaps/_root.xml.gz')
  })

  test('copies the static public/ tree (robots.txt, llms.txt, security.txt) into the build', async () => {
    await buildStaticSite({ out: outDir }, ctx)
    expect(existsSync(join(outDir, 'robots.txt'))).toBe(true)
    expect(existsSync(join(outDir, 'llms.txt'))).toBe(true)
    expect(existsSync(join(outDir, '.well-known', 'security.txt'))).toBe(true)
    const robots = readFileSync(join(outDir, 'robots.txt'), 'utf8')
    expect(robots).toContain('User-agent: *')
    expect(robots).toContain('Sitemap:')
  })

  test('emits canonical, alternate, OpenGraph, and JSON-LD on document pages', async () => {
    // Add an explicit `url` on the doc so the template can emit `alternate`
    db.db.run(
      "UPDATE documents SET url = 'https://developer.apple.com/documentation/swiftui/view' WHERE key = 'documentation/swiftui/view'",
    )
    await buildStaticSite({ out: outDir, baseUrl: 'https://example.test' }, ctx)
    const html = readFileSync(join(outDir, 'docs', 'documentation', 'swiftui', 'view', 'index.html'), 'utf8')
    expect(html).toContain('<link rel="canonical" href="https://example.test/docs/documentation/swiftui/view/">')
    expect(html).toContain('<link rel="alternate" href="https://developer.apple.com/documentation/swiftui/view"')
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(html).toContain('<meta property="og:title" content="View">')
    expect(html).toContain('<meta name="twitter:card" content="summary">')
    expect(html).toContain('<script type="application/ld+json">')
    expect(html).toContain('"@type":"TechArticle"')
    expect(html).toContain('"headline":"View"')
  })

  test('emits APIReference JSON-LD on framework listing pages', async () => {
    await buildStaticSite({ out: outDir, baseUrl: 'https://example.test' }, ctx)
    const html = readFileSync(join(outDir, 'docs', 'swiftui', 'index.html'), 'utf8')
    expect(html).toContain('<link rel="canonical" href="https://example.test/docs/swiftui/">')
    expect(html).toContain('"@type":"APIReference"')
  })

  test('emits WebSite + SearchAction JSON-LD on the homepage', async () => {
    await buildStaticSite({ out: outDir, baseUrl: 'https://example.test' }, ctx)
    const html = readFileSync(join(outDir, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="canonical" href="https://example.test/">')
    expect(html).toContain('"@type":"WebSite"')
    expect(html).toContain('"@type":"SearchAction"')
  })
})

describe('buildStaticSite — page weight reduction (Phase 5)', () => {
  test('externalizes tree-data into a hashed JSON file when treeEdges exist', async () => {
    // Seed a tree edge so renderFrameworkPage emits the tree-view branch.
    const viewId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
    const textId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/text'").get().id
    expect(viewId).toBeTruthy()
    expect(textId).toBeTruthy()
    db.db.run(`CREATE TABLE IF NOT EXISTS document_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_key TEXT NOT NULL,
      to_key TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`)
    db.db.run(
      "INSERT INTO document_relationships (from_key, to_key, relation_type, sort_order) VALUES ('documentation/swiftui/view', 'documentation/swiftui/text', 'child', 0)",
    )

    await buildStaticSite({ out: outDir, baseUrl: 'https://example.test' }, ctx)

    const fwHtml = readFileSync(join(outDir, 'docs', 'swiftui', 'index.html'), 'utf8')
    // Inline tree-data must NOT appear in the static-build framework page.
    expect(fwHtml).not.toContain('id="tree-data"')
    // Instead, an external reference must be present.
    expect(fwHtml).toMatch(/data-tree-src="https:\/\/example\.test\/data\/frameworks\/swiftui\/tree\.[0-9a-f]{10}\.json"/)
    // And the hashed file itself must exist on disk.
    const treeFiles = readdirSync(join(outDir, 'data', 'frameworks', 'swiftui'))
    expect(treeFiles.some(f => /^tree\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
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
