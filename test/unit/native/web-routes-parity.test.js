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
})
