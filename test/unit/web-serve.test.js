import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { startDevServer } from '../../src/web/serve.js'

let db
let ctx
let serverInfo

beforeEach(async () => {
  db = new DocsDatabase(':memory:')

  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/swiftui/view',
    url: 'https://developer.apple.com/documentation/swiftui/view',
    title: 'View',
    role: 'symbol',
    roleHeading: 'Protocol',
    abstract: 'A type that represents part of your app UI',
    platforms: null,
    declaration: null,
    etag: null,
    lastModified: null,
    contentHash: 'test',
    downloadedAt: new Date().toISOString(),
    sourceType: 'apple-docc',
  })
  const docId = db.db.query("SELECT id FROM documents WHERE key = 'documentation/swiftui/view'").get().id
  db.db.run(`INSERT OR REPLACE INTO document_sections (document_id, section_kind, heading, content_text, sort_order) VALUES (?, 'abstract', NULL, 'A type that represents part of your app UI', 0)`, [docId])

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app UI',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app UI', sortOrder: 0 },
    ],
    relationships: [
      { fromKey: 'documentation/swiftui/view', toKey: 'documentation/swiftui/text', relationType: 'child', section: 'Topics', sortOrder: 0 },
    ],
  })

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/text',
      title: 'Text',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Structure',
      framework: 'swiftui',
      abstractText: 'A view that displays read-only text.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A view that displays read-only text.', sortOrder: 0 },
    ],
    relationships: [],
  })

  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'documentation/swiftui/copying-data',
      title: 'Copying Data',
      kind: 'article',
      role: 'article',
      roleHeading: 'Article',
      framework: 'swiftui',
      abstractText: 'Learn how to copy values safely.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'Learn how to copy values safely.', sortOrder: 0 },
    ],
    relationships: [],
  })

  for (let i = 0; i < 24; i++) {
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key: `documentation/swiftui/mock-${i}`,
        title: `Mock ${i}`,
        kind: 'symbol',
        role: 'symbol',
        roleHeading: 'Structure',
        framework: 'swiftui',
        abstractText: `Synthetic result ${i}.`,
      },
      sections: [
        { sectionKind: 'abstract', contentText: `Synthetic result ${i}.`, sortOrder: 0 },
      ],
      relationships: [],
    })
  }

  const fontPath = `/tmp/apple-docs-web-test-font-${process.pid}.ttf`
  const variableFontPath = `/tmp/apple-docs-web-test-font-${process.pid}-vf.ttf`
  await Bun.write(fontPath, 'fake-font')
  await Bun.write(variableFontPath, 'fake-variable-font')
  db.upsertAppleFontFamily({ id: 'sf-pro', displayName: 'SF Pro', category: 'sans-serif' })
  db.upsertAppleFontFile({
    id: 'font-web-test',
    familyId: 'sf-pro',
    fileName: 'SF-Pro-Display-Bold.ttf',
    filePath: fontPath,
    format: 'ttf',
    size: 9,
    source: 'remote',
    variant: 'Display',
    weight: 'Bold',
    italic: false,
    isVariable: false,
  })
  db.upsertAppleFontFile({
    id: 'font-web-test-vf',
    familyId: 'sf-pro',
    fileName: 'SF-Pro.ttf',
    filePath: variableFontPath,
    format: 'ttf',
    size: 18,
    source: 'remote',
    isVariable: true,
    axes: [{ tag: 'wght', min: 100, default: 400, max: 900 }],
  })
  db.upsertSfSymbol({
    name: 'pencil.and.sparkles',
    scope: 'private',
    categories: ['editing'],
    keywords: ['sparkles', 'write'],
    orderIndex: 0,
  })

  ctx = { db, dataDir: '/tmp', logger: { info() {}, warn() {}, error() {} } }
  serverInfo = await startDevServer({ port: 0 }, ctx)
})

afterEach(() => {
  serverInfo.server.stop(true)
  db.close()
})

describe('Dev Server (P7-E)', () => {
  test('serves landing page at /', async () => {
    const res = await fetch(`${serverInfo.url}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('swiftui')
  })

  test('/healthz returns 200 without touching the database', async () => {
    const closedDb = new DocsDatabase(':memory:')
    closedDb.db.close()
    const local = await startDevServer(
      { port: 0 },
      { db: closedDb, dataDir: '/tmp/apple-docs-test', logger: { info() {}, warn() {} } },
    )
    try {
      const res = await fetch(`${local.url}/healthz`)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.json()).toEqual({ ok: true, service: 'apple-docs-web' })
    } finally {
      local.server.stop(true)
    }
  })

  test('serves document page at /docs/{key}', async () => {
    const res = await fetch(`${serverInfo.url}/docs/documentation/swiftui/view`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('View')
    expect(html).toContain('<!DOCTYPE html>')
  })

  test('serves framework listing at /docs/{slug}', async () => {
    const res = await fetch(`${serverInfo.url}/docs/swiftui`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('View')
    // The framework page now externalises the tree-view JSON: HTML
    // carries a `data-tree-src=…/tree.<hash>.json` reference and the
    // /data/frameworks/<slug>/tree.<hash>.json route serves the JSON.
    expect(html).toMatch(/data-tree-src="[^"]*\/data\/frameworks\/swiftui\/tree\.[0-9a-f]{10}\.json"/)
    expect(html).toContain('class="view-toggle"')
  })

  test('serves the externalised framework tree JSON via the data route', async () => {
    // First render the framework page so the tree JSON is computed and
    // cached under the URL the HTML emits.
    const html = await (await fetch(`${serverInfo.url}/docs/swiftui`)).text()
    const match = html.match(/data-tree-src="([^"]*\/data\/frameworks\/swiftui\/tree\.[0-9a-f]{10}\.json)"/)
    expect(match).not.toBeNull()
    const treeUrl = new URL(match[1], serverInfo.url).pathname
    const res = await fetch(`${serverInfo.url}${treeUrl}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const body = await res.json()
    expect(body).toBeDefined()
  })

  test('framework tree route 404s on an unknown framework slug', async () => {
    const res = await fetch(`${serverInfo.url}/data/frameworks/nope/tree.0123456789.json`)
    expect(res.status).toBe(404)
  })

  test('returns 404 for unknown document', async () => {
    const res = await fetch(`${serverInfo.url}/docs/nonexistent/path`)
    expect(res.status).toBe(404)
  })

  test('returns 404 for unknown path', async () => {
    const res = await fetch(`${serverInfo.url}/unknown`)
    expect(res.status).toBe(404)
  })

  test('serves CSS from /assets/ with immutable cache headers', async () => {
    // Asset URLs are versioned (`?v=<assetVersion>`), so the response is safe
    // to cache for a year. In production Caddy serves these from disk and
    // overrides the header anyway; this assertion locks in the value Bun
    // sends when running standalone via `apple-docs web serve`.
    const res = await fetch(`${serverInfo.url}/assets/style.css`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('cache-control')).toContain('max-age=31536000')
  })

  test('synthesises /assets/core.js as a minified IIFE bundle', async () => {
    const res = await fetch(`${serverInfo.url}/assets/core.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    expect(res.headers.get('cache-control')).toContain('immutable')
    const code = await res.text()
    expect(code.length).toBeGreaterThan(100)
    // Bun.build with format:'iife' wraps the bundle in `(()=>{ … })()`
    expect(code).toMatch(/^\(\(\)=>\{/)
    // No ESM-export shim should leak into a script that loads via <script src>
    expect(code).not.toContain('__esModule')
    // Theme controller's data-theme write must reach the bundle
    expect(code).toContain('data-theme')
  })

  test('synthesises /assets/listing.js as a minified IIFE bundle', async () => {
    const res = await fetch(`${serverInfo.url}/assets/listing.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const code = await res.text()
    expect(code).toMatch(/^\(\(\)=>\{/)
    expect(code).not.toContain('__esModule')
  })

  test('serves /assets/lang-toggle.js as a minified IIFE', async () => {
    const res = await fetch(`${serverInfo.url}/assets/lang-toggle.js`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
    const code = await res.text()
    expect(code).toMatch(/^\(\(\)=>\{/)
    expect(code).toContain('apple-docs-lang')
  })

  test('refuses asset paths that try to escape the assets directory', async () => {
    const traversal = await fetch(`${serverInfo.url}/assets/..%2Fpackage.json`)
    expect(traversal.status).toBe(403)
  })

  test('live search API works', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('live search API caches identical responses in-process', async () => {
    const first = await fetch(`${serverInfo.url}/api/search?q=View&limit=10`)
    const second = await fetch(`${serverInfo.url}/api/search?q=View&limit=10`)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(first.headers.get('x-apple-docs-cache')).toBe('miss')
    expect(second.headers.get('x-apple-docs-cache')).toBe('hit')
  })

  test('/api/search advertises shared-cache directives so Cloudflare can store responses', async () => {
    const miss = await fetch(`${serverInfo.url}/api/search?q=View&limit=10&framework=cache-test-framework-x`)
    const hit = await fetch(`${serverInfo.url}/api/search?q=View&limit=10&framework=cache-test-framework-x`)
    expect(miss.headers.get('cache-control')).toContain('public')
    expect(miss.headers.get('cache-control')).toContain('max-age=300')
    expect(miss.headers.get('cache-control')).toContain('stale-while-revalidate')
    expect(hit.headers.get('cache-control')).toBe(miss.headers.get('cache-control'))
  })

  test('/api/filters advertises shared-cache directives', async () => {
    const res = await fetch(`${serverInfo.url}/api/filters`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('public')
    expect(res.headers.get('cache-control')).toContain('max-age=300')
  })

  test('title index endpoint returns v2 columnar format', async () => {
    const res = await fetch(`${serverInfo.url}/data/search/title-index.json`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.v).toBe(2)
    expect(data.frameworks).toBeDefined()
    expect(data.keys).toBeDefined()
    expect(data.titles).toBeDefined()
  })

  test('search manifest endpoint returns v2 with file mappings', async () => {
    const res = await fetch(`${serverInfo.url}/data/search/search-manifest.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('no-cache')
    expect(res.headers.get('etag')).toBeTruthy()
    const manifest = await res.json()
    expect(manifest.version).toBe(2)
    expect(manifest.files).toBeDefined()
    expect(manifest.files['title-index']).toMatch(/^title-index\.[0-9a-f]{10}\.json$/)
  })

  test('search manifest endpoint returns 304 for matching If-None-Match', async () => {
    const first = await fetch(`${serverInfo.url}/data/search/search-manifest.json`)
    const etag = first.headers.get('etag')

    const second = await fetch(`${serverInfo.url}/data/search/search-manifest.json`, {
      headers: { 'If-None-Match': etag },
    })

    expect(etag).toBeTruthy()
    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })

  test('content-hashed search file returns immutable cache headers', async () => {
    // First get the manifest to find the hashed filename
    const manifestRes = await fetch(`${serverInfo.url}/data/search/search-manifest.json`)
    const manifest = await manifestRes.json()
    const titleFile = manifest.files['title-index']
    const res = await fetch(`${serverInfo.url}/data/search/${titleFile}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')
    expect(res.headers.get('etag')).toBeTruthy()
    const data = await res.json()
    expect(data.v).toBe(2)
  })

  test('document pages return gzip and stable etags when requested', async () => {
    const first = await fetch(`${serverInfo.url}/docs/documentation/swiftui/view`, {
      headers: { 'Accept-Encoding': 'gzip' },
    })
    const etag = first.headers.get('etag')

    expect(first.status).toBe(200)
    expect(first.headers.get('content-encoding')).toBe('gzip')
    expect(etag).toBeTruthy()

    const second = await fetch(`${serverInfo.url}/docs/documentation/swiftui/view`, {
      headers: {
        'Accept-Encoding': 'gzip',
        'If-None-Match': etag,
      },
    })

    expect(second.status).toBe(304)
    expect(second.headers.get('etag')).toBe(etag)
  })

  test('serves search page at /search', async () => {
    const res = await fetch(`${serverInfo.url}/search`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('search-form')
    expect(html).toContain('search-page.js')
  })

  test('serves search page at /search/', async () => {
    const res = await fetch(`${serverInfo.url}/search/`)
    expect(res.status).toBe(200)
  })

  test('serves /fonts page and font APIs', async () => {
    const page = await fetch(`${serverInfo.url}/fonts`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Apple Fonts')

    const fonts = await fetch(`${serverInfo.url}/api/fonts`)
    expect(fonts.status).toBe(200)
    const fontsJson = await fonts.json()
    expect(fontsJson.families[0].files[0].id).toBe('font-web-test')

    const fontFile = await fetch(`${serverInfo.url}/api/fonts/file/font-web-test`)
    expect(fontFile.status).toBe(200)
    expect(fontFile.headers.get('content-type')).toContain('font/ttf')
    expect(await fontFile.text()).toBe('fake-font')
    // Cache contract: stable URL + revalidation-friendly ETag, NOT
    // `immutable` — Apple ships new font versions every macOS cycle and
    // `immutable` would pin browser caches across upgrades.
    expect(fontFile.headers.get('etag')).toBeTruthy()
    expect(fontFile.headers.get('cache-control')).toContain('must-revalidate')
    expect(fontFile.headers.get('cache-control')).not.toContain('immutable')

    // Conditional GET round-trip — server should answer 304 when the
    // ETag matches the on-disk mtime+size pair.
    const conditional = await fetch(`${serverInfo.url}/api/fonts/file/font-web-test`, {
      headers: { 'If-None-Match': fontFile.headers.get('etag') },
    })
    expect(conditional.status).toBe(304)

    // The fixture writes literal "fake-font" bytes to disk. CTFontManager
    // on macOS CI runners can stall on a non-SFNT file, so the route guards
    // against it by sniffing the magic header up-front and falling straight
    // to the placeholder SVG. The 200 + SVG body assertions below pass on
    // both the curve renderer (real font) and the placeholder (test fixture).
    const textSvg = await fetch(`${serverInfo.url}/api/fonts/text.svg?fontId=font-web-test&text=SF`)
    expect(textSvg.status).toBe(200)
    expect(textSvg.headers.get('content-type')).toContain('image/svg+xml')
    expect(await textSvg.text()).toContain('<svg')

    const familyZip = await fetch(`${serverInfo.url}/api/fonts/family/sf-pro.zip`)
    expect(familyZip.status).toBe(200)
    expect(familyZip.headers.get('content-type')).toBe('application/zip')
    const buf = new Uint8Array(await familyZip.arrayBuffer())
    // PK\x03\x04 local file header magic
    expect(buf[0]).toBe(0x50)
    expect(buf[1]).toBe(0x4b)
    expect(buf[2]).toBe(0x03)
    expect(buf[3]).toBe(0x04)

    // Variable subset must contain only the VF entry, not the static one.
    const variableZip = await fetch(`${serverInfo.url}/api/fonts/family/sf-pro.zip?subset=variable`)
    expect(variableZip.status).toBe(200)
    const variableBytes = new Uint8Array(await variableZip.arrayBuffer())
    const variableText = new TextDecoder('latin1').decode(variableBytes)
    expect(variableText).toContain('SF-Pro.ttf')
    expect(variableText).not.toContain('SF-Pro-Display-Bold.ttf')

    const staticZip = await fetch(`${serverInfo.url}/api/fonts/family/sf-pro.zip?subset=static`)
    expect(staticZip.status).toBe(200)
    const staticText = new TextDecoder('latin1').decode(new Uint8Array(await staticZip.arrayBuffer()))
    expect(staticText).toContain('SF-Pro-Display-Bold.ttf')
    expect(staticText).not.toContain('SF-Pro.ttf"')
  })

  test('home page surfaces fonts and symbols inside the design section', async () => {
    const res = await fetch(`${serverInfo.url}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('id="design"')
    expect(html).toMatch(/<a href="\/fonts">Apple Fonts<\/a>/)
    expect(html).toMatch(/<a href="\/symbols">SF Symbols<\/a>/)
  })

  test('serves /symbols page and symbol APIs', async () => {
    const page = await fetch(`${serverInfo.url}/symbols`)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('SF Symbols')
    // P7 redesign: pure-glyph grid + sticky global toolbar + Phosphor
    // pattern customizer (no always-on labels). Lock in the contract.
    expect(html).toContain('symbols-grid')
    expect(html).toContain('symbols-toolbar')
    expect(html).toMatch(/aria-label="Search symbols"/)
    expect(html).toContain('symbols-categories')
    // Mobile category select is part of the page so the toolbar stays
    // composable with desktop rail filtering.
    expect(html).toContain('id="symbols-category-mobile"')

    const index = await fetch(`${serverInfo.url}/api/symbols/index.json`)
    expect(index.status).toBe(200)
    const indexJson = await index.json()
    expect(Array.isArray(indexJson.symbols)).toBe(true)
    expect(indexJson.count).toBe(indexJson.symbols.length)
    expect(indexJson.symbols.find(s => s.name === 'pencil.and.sparkles')).toBeTruthy()

    const search = await fetch(`${serverInfo.url}/api/symbols/search?q=sparkles&scope=private`)
    expect(search.status).toBe(200)
    const searchJson = await search.json()
    expect(searchJson.results[0].name).toBe('pencil.and.sparkles')
  })

  test('/symbols/<name> serves the same shell so client-side routing works', async () => {
    // Mobile detail UX is a route, not a drawer (research §6.5). The
    // server returns the canonical /symbols HTML and symbols-page.js
    // detects the path and pre-opens the inspector. No 404.
    const res = await fetch(`${serverInfo.url}/symbols/pencil.and.sparkles`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('SF Symbols')
    expect(html).toContain('symbols-grid')
  })

  test('header omits /fonts and /symbols nav links', async () => {
    // P7: /fonts and /symbols moved out of the global header nav into
    // the home-page Design section to fix the ≤480px overflow that the
    // research synthesis (§2 #1) flagged. The home test above already
    // asserts they remain reachable from /; this test pins the inverse
    // — they are NOT in the chrome on every page.
    const res = await fetch(`${serverInfo.url}/`)
    const html = await res.text()
    // Site-wide header markup — no <a href="/fonts"> or <a href="/symbols">
    // inside the .site-header element.
    const headerMatch = html.match(/<header class="site-header">[\s\S]*?<\/header>/)
    expect(headerMatch).toBeTruthy()
    expect(headerMatch[0]).not.toContain('href="/fonts"')
    expect(headerMatch[0]).not.toContain('href="/symbols"')
    expect(headerMatch[0]).not.toContain('class="site-link"')
  })

  test('stylesheet locks in the symbols + fonts redesign contract', async () => {
    // The research synthesis (§10) calls out the explicit stylesheet
    // contract: sticky toolbar, content-visibility on the grid,
    // CSS custom props (`--symbol-color`/`-size`/`-weight`/`-scale`,
    // `--sample-text`), `repeat(auto-fill, minmax(...))` for tile cols.
    const res = await fetch(`${serverInfo.url}/assets/style.css`)
    expect(res.status).toBe(200)
    const css = await res.text()
    expect(css).toContain('--symbol-color')
    expect(css).toContain('--symbol-size')
    expect(css).toContain('--symbol-weight')
    expect(css).toContain('--symbol-scale')
    expect(css).toContain('content-visibility: auto')
    expect(css).toMatch(/\.symbols-toolbar\s*\{[^}]*position:\s*sticky/)
    expect(css).toMatch(/grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(/)
  })

  test('/api/search accepts kind filter', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&kind=symbol`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/search kind filter matches displayed kinds', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=Copying&kind=Article`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toHaveLength(1)
    expect(data.results[0].path).toBe('documentation/swiftui/copying-data')
    expect(data.results[0].kind).toBe('Article')
  })

  test('/api/search accepts platform filter', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&platform=ios`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/search accepts limit and offset', async () => {
    const first = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=5&offset=0`)
    const second = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=5&offset=5`)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstData = await first.json()
    const secondData = await second.json()
    expect(firstData.results).toHaveLength(5)
    expect(secondData.results).toHaveLength(5)
    expect(firstData.results[0].path).not.toBe(secondData.results[0].path)
  })

  test('/api/search offset applies before pagination truncation', async () => {
    const first = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=10&offset=0`)
    const second = await fetch(`${serverInfo.url}/api/search?q=Mock&limit=10&offset=10`)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    const firstData = await first.json()
    const secondData = await second.json()
    const firstPaths = new Set(firstData.results.map(r => r.path))
    expect(secondData.results).toHaveLength(10)
    expect(secondData.results.every(r => !firstPaths.has(r.path))).toBe(true)
  })

  test('/api/search accepts min version filters', async () => {
    const res = await fetch(`${serverInfo.url}/api/search?q=View&min_ios=13.0`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.results).toBeDefined()
  })

  test('/api/filters returns filter options', async () => {
    const res = await fetch(`${serverInfo.url}/api/filters`)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.frameworks).toBeArray()
    expect(data.kinds).toBeArray()
    // Frameworks now return {label, value} objects with display names
    const fwValues = data.frameworks.map(f => f.value)
    expect(fwValues).toContain('swiftui')
  })
})
