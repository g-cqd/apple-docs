import { describe, test, expect, afterEach } from 'bun:test'
import {
  buildRobotsTxt,
  buildOpenSearchXml,
  buildApiCatalog,
  buildMcpServerCard,
  buildHeadersFile,
  contentSignal,
  DISCOVERY_LINKS,
  DEFAULT_CONTENT_SIGNAL,
  MCP_TOOLS,
  MCP_RESOURCE_TEMPLATES,
} from '../../../src/web/discovery.js'
import { buildFontFaceCss, fontFaceName, formatHint } from '../../../src/web/lib/font-faces.js'

afterEach(() => {
  delete process.env.APPLE_DOCS_CONTENT_SIGNAL
})

describe('discovery: buildRobotsTxt', () => {
  test('emits a Content-Signal directive and an absolute Sitemap from baseUrl', () => {
    const txt = buildRobotsTxt({ baseUrl: 'https://docs.example.com' })
    expect(txt).toContain('User-agent: *')
    expect(txt).toContain(`Content-Signal: ${DEFAULT_CONTENT_SIGNAL}`)
    expect(txt).toContain('Disallow: /api/')
    expect(txt).toContain('Sitemap: https://docs.example.com/sitemap.xml')
  })

  test('trailing slashes on baseUrl do not double up in the Sitemap URL', () => {
    const txt = buildRobotsTxt({ baseUrl: 'https://docs.example.com/' })
    expect(txt).toContain('Sitemap: https://docs.example.com/sitemap.xml')
  })

  test('env override drives the content-signal policy', () => {
    process.env.APPLE_DOCS_CONTENT_SIGNAL = 'search=yes, ai-input=no, ai-train=no'
    expect(buildRobotsTxt({})).toContain('Content-Signal: search=yes, ai-input=no, ai-train=no')
  })

  test('siteConfig.contentSignal wins over the env override', () => {
    process.env.APPLE_DOCS_CONTENT_SIGNAL = 'search=yes, ai-input=no, ai-train=no'
    expect(contentSignal({ contentSignal: 'search=no' })).toBe('search=no')
  })
})

describe('discovery: buildOpenSearchXml', () => {
  test('valid OpenSearch 1.1 doc targeting /search?q={searchTerms} from baseUrl', () => {
    const xml = buildOpenSearchXml({ baseUrl: 'https://docs.example.com', siteName: 'Example Docs' })
    expect(xml).toContain('xmlns="http://a9.com/-/spec/opensearch/1.1/"')
    expect(xml).toContain('<Url type="text/html" method="get" template="https://docs.example.com/search?q={searchTerms}"/>')
    expect(xml).toContain('rel="self" template="https://docs.example.com/opensearch.xml"')
    expect(xml).toContain('<LongName>Example Docs</LongName>')
  })

  test('ShortName respects the 16-char OpenSearch limit', () => {
    const xml = buildOpenSearchXml({ searchShortName: 'A Very Long Search Source Name' })
    const short = xml.match(/<ShortName>([^<]*)<\/ShortName>/)?.[1]
    expect(short.length).toBeLessThanOrEqual(16)
  })

  test('escapes XML metacharacters in the site name', () => {
    const xml = buildOpenSearchXml({ siteName: 'Docs & <Co>' })
    expect(xml).toContain('Docs &amp; &lt;Co&gt;')
    expect(xml).not.toContain('Docs & <Co>')
  })
})

describe('discovery: buildApiCatalog', () => {
  test('is an RFC 9264 linkset anchored at the configured origin', () => {
    const catalog = buildApiCatalog({ baseUrl: 'https://docs.example.com' })
    expect(Array.isArray(catalog.linkset)).toBe(true)
    const ctx = catalog.linkset[0]
    expect(ctx.anchor).toBe('https://docs.example.com/')
    expect(ctx['service-doc'][0].href).toBe('https://docs.example.com/docs/')
    expect(ctx.status[0].href).toBe('https://docs.example.com/readyz')
    expect(ctx.item.map(i => i.href)).toContain('https://docs.example.com/api/search')
    expect(ctx.related[0].href).toBe('https://docs.example.com/.well-known/mcp/server-card.json')
  })

  test('falls back to relative paths when no baseUrl is configured (dev)', () => {
    const ctx = buildApiCatalog({}).linkset[0]
    expect(ctx.anchor).toBe('/')
    expect(ctx['service-doc'][0].href).toBe('/docs/')
  })
})

describe('discovery: buildMcpServerCard', () => {
  test('carries identity, transport, capabilities, and the tool/resource lists', () => {
    const card = buildMcpServerCard({ baseUrl: 'https://docs.example.com' }, '9.9.9')
    expect(card.serverInfo).toEqual({ name: 'apple-docs', version: '9.9.9' })
    expect(card.transport).toEqual({ type: 'streamable-http', endpoint: 'https://docs.example.com/mcp' })
    expect(card.capabilities).toEqual(['tools', 'resources'])
    expect(card.tools).toEqual([...MCP_TOOLS])
    expect(card.tools).toHaveLength(9)
    expect(card.resources).toEqual([...MCP_RESOURCE_TEMPLATES])
    expect(card.resources).toHaveLength(4)
  })
})

describe('discovery: buildHeadersFile + DISCOVERY_LINKS', () => {
  test('_headers mirrors the Link/Vary/Content-Signal set for static CDNs', () => {
    const headers = buildHeadersFile({})
    expect(headers).toContain('/*')
    expect(headers).toContain(`Link: ${DISCOVERY_LINKS}`)
    expect(headers).toContain('Vary: Accept')
    expect(headers).toContain(`Content-Signal: ${DEFAULT_CONTENT_SIGNAL}`)
    // The extension-less catalog file needs its linkset type pinned.
    expect(headers).toContain('/.well-known/api-catalog')
    expect(headers).toContain('Content-Type: application/linkset+json')
  })

  test('DISCOVERY_LINKS advertises sitemap, api-catalog, and service-doc relations', () => {
    expect(DISCOVERY_LINKS).toContain('</sitemap.xml>; rel="sitemap"')
    expect(DISCOVERY_LINKS).toContain('</.well-known/api-catalog>; rel="api-catalog"')
    expect(DISCOVERY_LINKS).toContain('</docs/>; rel="service-doc"')
  })
})

describe('font-faces builder', () => {
  test('fontFaceName is deterministic from family + file id', () => {
    expect(fontFaceName('sf-pro', 'abc')).toBe('apple-docs-sf-pro-abc')
  })

  test('formatHint maps known extensions and blanks the rest', () => {
    expect(formatHint('ttf')).toBe('truetype')
    expect(formatHint('OTF')).toBe('opentype')
    expect(formatHint('ttc')).toBe('collection')
    expect(formatHint('woff2')).toBe('')
    expect(formatHint(undefined)).toBe('')
  })

  test('buildFontFaceCss emits one @font-face per file with the default route URL', () => {
    const css = buildFontFaceCss([
      { id: 'sf-pro', files: [{ id: 'f1', format: 'ttf' }, { id: 'f2', format: 'otf' }] },
    ])
    expect(css).toContain('@font-face { font-family: "apple-docs-sf-pro-f1"; src: url("/api/fonts/file/f1") format("truetype"); font-display: swap; }')
    expect(css).toContain('format("opentype")')
    expect(css.split('@font-face')).toHaveLength(3) // 2 rules → split yields [pre, r1, r2]
  })

  test('a custom fileUrl builder (static build) is honoured', () => {
    const css = buildFontFaceCss(
      [{ id: 'sf-pro', files: [{ id: 'f1', format: 'ttf' }] }],
      { fileUrl: (id) => `https://cdn.example.com/api/fonts/file/${id}` },
    )
    expect(css).toContain('src: url("https://cdn.example.com/api/fonts/file/f1")')
  })

  test('omits the format() clause for unknown formats', () => {
    const css = buildFontFaceCss([{ id: 'x', files: [{ id: 'f', format: 'woff2' }] }])
    expect(css).toBe('@font-face { font-family: "apple-docs-x-f"; src: url("/api/fonts/file/f"); font-display: swap; }')
  })
})
