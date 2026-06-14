/**
 * Byte-parity gate for the native web API routes (RFC 0001 P6 web slice). The
 * ad-server JSON/text routes must match the Bun web handlers byte-for-byte
 * (body) plus the deterministic headers (content-type, cache-control, the
 * cross-cutting security/Link/Vary set). Non-deterministic headers (Date,
 * X-Request-Id) are excluded.
 *
 * Boots ad-server (release) as a subprocess and compares over HTTP. Skipped
 * when the release binary is absent. Extended per phase: P1 filters + readyz.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'
import { filtersHandler } from '../../../src/web/routes/filters.route.js'
import { listFontsHandler, fontFacesCssHandler } from '../../../src/web/routes/fonts.route.js'
import { symbolsIndexHandler } from '../../../src/web/routes/symbols-index.route.js'
import { symbolsSearchHandler, symbolMetadataHandler } from '../../../src/web/routes/symbols.route.js'
import { buildTitleIndex, buildAliasMap } from '../../../src/web/search-artifacts.js'
import { buildRobotsTxt, buildOpenSearchXml, buildApiCatalog, buildMcpServerCard } from '../../../src/web/discovery.js'
import { VERSION } from '../../../src/lib/version.js'
import { sha256 } from '../../../src/lib/hash.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const PORT = 3043
// Non-default siteConfig so the discovery builders exercise origin() + url()
// (absolute URLs) and the content-signal / short-name overrides.
const SITE = {
  baseUrl: 'https://docs.example.test',
  siteName: 'Test Apple Docs',
  searchShortName: 'TestDocs',
  contentSignal: 'search=yes, ai-input=no',
}
let dir
let db
let server
let ready = false

// JSON routes are gated on INTRINSIC identity — deep-equal on the PARSED JSON
// (D2), not byte. (Array order is still semantic and must match.) Text routes
// (robots/opensearch/faces.css) have no canonical parse → byte-compared.
function expectIntrinsic(actual, expected) {
  expect(JSON.parse(actual)).toEqual(JSON.parse(expected))
}

if (existsSync(AD_SERVER)) {
  dir = mkdtempSync(join(tmpdir(), 'web-parity-'))
  const dbPath = join(dir, 'corpus.db')
  const seed = new DocsDatabase(dbPath)
  seed.upsertRoot('swiftui', 'SwiftUI', 'framework', 'seed')
  seed.upsertRoot('uikit', 'UIKit', 'framework', 'seed')
  // metal has no root (→ COALESCE falls back to the framework slug); wwdc docs
  // carry source_metadata.year (the wwdcYears facet source).
  const DOCS = [
    { key: 'swiftui/view', title: 'View', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Protocol', kind: 'protocol', language: 'swift', abstractText: 'A view.', urlDepth: 2 },
    { key: 'swiftui/stack', title: 'Stack', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'A stack.', urlDepth: 2 },
    { key: 'uikit/uiview', title: 'UIView', framework: 'uikit', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'occ', abstractText: 'A uiview.', urlDepth: 2 },
    { key: 'metal/device', title: 'MTLDevice', framework: 'metal', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'protocol', language: 'occ', abstractText: 'A device.', urlDepth: 2 },
    { key: 'wwdc/talk1', title: 'Talk 1', framework: 'wwdc', sourceType: 'wwdc', role: 'article', roleHeading: 'Session', kind: 'article', language: 'swift', abstractText: 'A talk.', urlDepth: 2 },
    { key: 'wwdc/talk2', title: 'Talk 2', framework: 'wwdc', sourceType: 'wwdc', role: 'article', roleHeading: 'Session', kind: 'article', language: 'swift', abstractText: 'A talk.', urlDepth: 2 },
    { key: 'wwdc/talk3', title: 'Talk 3', framework: 'wwdc', sourceType: 'wwdc', role: 'article', roleHeading: 'Session', kind: 'article', language: 'swift', abstractText: 'A talk.', urlDepth: 2 },
  ]
  for (const d of DOCS) seed.upsertDocument(d)
  const stampYear = seed.db.query('UPDATE documents SET source_metadata = ? WHERE key = ?')
  stampYear.run(JSON.stringify({ year: 2024 }), 'wwdc/talk1')
  stampYear.run(JSON.stringify({ year: 2024 }), 'wwdc/talk2')
  stampYear.run(JSON.stringify({ year: 2023 }), 'wwdc/talk3')
  // Fonts (Phase 2): families ORDER BY display_name (New York < SF Pro), each
  // family's files ORDER BY file_name (SF-Pro-Bold < SF-Pro-Regular).
  seed.assetsFonts.upsertFontFamily({ id: 'sf-pro', displayName: 'SF Pro' })
  seed.assetsFonts.upsertFontFamily({ id: 'ny', displayName: 'New York' })
  seed.assetsFonts.upsertFontFile({ id: 'sf-pro-bold', familyId: 'sf-pro', fileName: 'SF-Pro-Bold.otf', filePath: '/x/SF-Pro-Bold.otf', format: 'otf' })
  seed.assetsFonts.upsertFontFile({ id: 'sf-pro-regular', familyId: 'sf-pro', fileName: 'SF-Pro-Regular.otf', filePath: '/x/SF-Pro-Regular.otf', format: 'otf' })
  seed.assetsFonts.upsertFontFile({ id: 'ny-regular', familyId: 'ny', fileName: 'NewYork.ttf', filePath: '/x/NewYork.ttf', format: 'ttf' })
  // SF Symbols (Phase 2): catalog + FTS index; circle.fill gets a PUA codepoint
  // (→ codepoint_display on metadata), square.grid.2x2 stays null (→ omitted).
  seed.assetsSymbols.upsertSymbol({ name: 'square.grid.2x2', scope: 'public', categories: ['ui', 'grid'], keywords: ['square', 'grid'], aliases: [], availability: { ios: '14.0', macos: '11.0' }, orderIndex: 0, bundlePath: 'sym/sq', bundleVersion: '14.6' })
  seed.assetsSymbols.upsertSymbol({ name: 'circle.fill', scope: 'public', categories: ['shapes'], keywords: ['circle', 'fill'], aliases: ['filled.circle'], availability: { ios: '13.0' }, orderIndex: 1, bundlePath: 'sym/ci', bundleVersion: '13.0' })
  seed.assetsSymbols.upsertSymbol({ name: 'lock.shield', scope: 'private', categories: [], keywords: ['lock', 'shield'], aliases: [], availability: null, orderIndex: 0 })
  seed.assetsSymbols.updateCodepoint('public', 'circle.fill', 59440, '13.0')
  // Framework synonyms (Phase 3 aliases map).
  try { seed.db.run("INSERT INTO framework_synonyms (canonical, alias) VALUES ('swiftui', 'su')") } catch {}
  try { seed.db.run("INSERT INTO framework_synonyms (canonical, alias) VALUES ('uikit', 'uk')") } catch {}
  seed.close()
  db = new DocsDatabase(dbPath)
  server = Bun.spawn([
    AD_SERVER, '--db', dbPath, '--port', String(PORT), '--threads', '2',
    '--base-url', SITE.baseUrl, '--site-name', SITE.siteName,
    '--search-short-name', SITE.searchShortName, '--content-signal', SITE.contentSignal,
    '--app-version', VERSION,
  ], { stdout: 'ignore', stderr: 'ignore' })
}

describe.skipIf(!existsSync(AD_SERVER))('web-routes parity (Swift ad-server == JS web handlers)', () => {
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) { ready = true; break } } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    server?.kill()
    db?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('ad-server is reachable', () => {
    expect(ready).toBe(true)
  })

  test('GET /api/filters — byte-identical body + headers', async () => {
    const jsResp = await filtersHandler(new Request('http://x/api/filters'), { db })
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/filters`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe(jsResp.headers.get('content-type'))
    expect(res.headers.get('cache-control')).toBe(jsResp.headers.get('cache-control'))
    // cross-cutting security + discovery layer (src/web/serve.js + context.js)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin')
    expect(res.headers.get('vary')).toBe('Accept')
    expect(res.headers.get('link')).toContain('rel="api-catalog"')
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('GET /readyz — ready (instance shape)', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/readyz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.db).toBe(true)
    expect(body.readerPool).toBe(null)
  })

  test('GET /robots.txt — byte-identical + ETag/304', async () => {
    const expected = buildRobotsTxt(SITE)
    const res = await fetch(`http://127.0.0.1:${PORT}/robots.txt`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600')
    const etag = res.headers.get('etag')
    expect(etag).toBe(`"${sha256(expected).slice(0, 16)}"`)
    const res304 = await fetch(`http://127.0.0.1:${PORT}/robots.txt`, { headers: { 'If-None-Match': etag } })
    expect(res304.status).toBe(304)
  })

  test('GET /opensearch.xml — byte-identical', async () => {
    const expected = buildOpenSearchXml(SITE)
    const res = await fetch(`http://127.0.0.1:${PORT}/opensearch.xml`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe('application/opensearchdescription+xml')
  })

  test('GET /.well-known/api-catalog — byte-identical', async () => {
    const expected = JSON.stringify(buildApiCatalog(SITE))
    const res = await fetch(`http://127.0.0.1:${PORT}/.well-known/api-catalog`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe('application/linkset+json')
  })

  test('GET /.well-known/mcp/server-card.json — byte-identical', async () => {
    const expected = JSON.stringify(buildMcpServerCard(SITE, VERSION))
    const res = await fetch(`http://127.0.0.1:${PORT}/.well-known/mcp/server-card.json`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe('application/json;charset=utf-8')
  })

  test('GET /api/fonts — intrinsic-identical (ADJSON model)', async () => {
    const jsResp = await listFontsHandler(new Request('http://x/api/fonts'), { db })
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/fonts`)
    expectIntrinsic(await res.text(), expected)
    expect(res.headers.get('content-type')).toBe(jsResp.headers.get('content-type'))
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{16}"$/)
  })

  test('GET /api/fonts/faces.css — byte-identical body', async () => {
    const jsResp = await fontFacesCssHandler(new Request('http://x/api/fonts/faces.css'), { db, siteConfig: SITE })
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/fonts/faces.css`)
    expect(await res.text()).toBe(expected)
    expect(res.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300, stale-while-revalidate=3600')
  })

  test('GET /api/symbols/index.json — intrinsic (ADJSON model)', async () => {
    const jsResp = await symbolsIndexHandler(new Request('http://x/api/symbols/index.json'), { db })
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/symbols/index.json`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /api/symbols/search — intrinsic (full-row ADJSON JSONValue)', async () => {
    const url = new URL('http://x/api/symbols/search?q=grid')
    const jsResp = await symbolsSearchHandler(new Request(url), { db }, url)
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/symbols/search?q=grid`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /api/symbols/<scope>/<name>.json — codepoint_display present', async () => {
    const jsResp = await symbolMetadataHandler(new Request('http://x'), { db }, null, [null, 'public', 'circle.fill'])
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/symbols/public/circle.fill.json`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /api/symbols/<scope>/<name>.json — codepoint omitted when null', async () => {
    const jsResp = await symbolMetadataHandler(new Request('http://x'), { db }, null, [null, 'public', 'square.grid.2x2'])
    const expected = await jsResp.text()
    const res = await fetch(`http://127.0.0.1:${PORT}/api/symbols/public/square.grid.2x2.json`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /api/symbols/<scope>/<name>.json — 404 on miss', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/symbols/public/does.not.exist.json`)
    expect(res.status).toBe(404)
  })

  test('GET /data/search/title-index.json — intrinsic (columnar)', async () => {
    const expected = JSON.stringify(buildTitleIndex(db))
    const res = await fetch(`http://127.0.0.1:${PORT}/data/search/title-index.json`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /data/search/aliases.json — intrinsic (alias map)', async () => {
    const expected = JSON.stringify(buildAliasMap(db))
    const res = await fetch(`http://127.0.0.1:${PORT}/data/search/aliases.json`)
    expectIntrinsic(await res.text(), expected)
  })

  test('GET /data/search/search-manifest.json — counts + self-coherent hash', async () => {
    const titleIndex = buildTitleIndex(db)
    const aliasMap = buildAliasMap(db)
    const res = await fetch(`http://127.0.0.1:${PORT}/data/search/search-manifest.json`)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    const manifest = await res.json()
    expect(manifest.version).toBe(2)
    expect(manifest.titleCount).toBe(titleIndex.keys.length)
    expect(manifest.aliasCount).toBe(Object.keys(aliasMap).length)
    expect(manifest.shardCount).toBe(0)
    // self-coherence (D2): the manifest filename hash == sha256 of the served
    // artifact, and that artifact is intrinsically the JS title index.
    const titleFile = manifest.files['title-index']
    const titleRes = await fetch(`http://127.0.0.1:${PORT}/data/search/${titleFile}`)
    const titleBody = await titleRes.text()
    expect(titleFile).toBe(`title-index.${sha256(titleBody).slice(0, 10)}.json`)
    expect(titleRes.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expectIntrinsic(titleBody, JSON.stringify(titleIndex))
  })
})
