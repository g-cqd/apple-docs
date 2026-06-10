// Agent-discovery affordances, shared by the Bun server routes
// (src/web/serve.js) and the static build (src/web/build.js) so the live
// site and the prebuilt CDN artifact emit byte-identical metadata.
//
// Surface:
//   - robots.txt           Content-Signal directive + sitemap pointer.
//   - /.well-known/api-catalog          RFC 9727 linkset (RFC 9264 JSON).
//   - /.well-known/mcp/server-card.json MCP server identity + tool list.
//   - DISCOVERY_LINKS      RFC 8288 Link header set added to every response.
//
// Every builder is a pure function of siteConfig (+ env policy) — no I/O,
// no DB — so both call sites stay in lockstep.

/**
 * Content-Signal policy (contentsignals.org / Cloudflare spec). Defaults to
 * the project's standing stance (matches the `Content-Signal` header Caddy
 * already emits in ops/caddy/Caddyfile.tpl) and is overridable per-deploy
 * via `siteConfig.contentSignal` or the `APPLE_DOCS_CONTENT_SIGNAL` env so
 * an operator can flip e.g. `ai-train=no` without code changes.
 */
export const DEFAULT_CONTENT_SIGNAL = 'search=yes, ai-input=yes, ai-train=yes'

/** MCP tool names exposed by the server (src/mcp/tools/*). */
export const MCP_TOOLS = Object.freeze([
  'search_docs',
  'read_doc',
  'list_frameworks',
  'browse',
  'list_taxonomy',
  'search_sf_symbols',
  'list_apple_fonts',
  'render_sf_symbol',
  'render_font_text',
])

/** MCP resource templates (src/mcp/server/resources.js). */
export const MCP_RESOURCE_TEMPLATES = Object.freeze([
  'apple-docs://doc/{+key}',
  'apple-docs://framework/{slug}',
  'apple-docs://sf-symbol/{scope}/{name}.{format}',
  'apple-docs://font/{id}',
])

/**
 * RFC 8288 `Link` header set advertised on every response. Relative
 * references resolve against the request URL, so one static value is
 * correct across dev, self-host, and CDN origins.
 */
export const DISCOVERY_LINKS = [
  '</sitemap.xml>; rel="sitemap"',
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</docs/>; rel="service-doc"',
  '</opensearch.xml>; rel="search"',
].join(', ')

/** Resolve the configured content-signal policy string. */
export function contentSignal(siteConfig = {}) {
  return siteConfig.contentSignal || process.env.APPLE_DOCS_CONTENT_SIGNAL || DEFAULT_CONTENT_SIGNAL
}

/** Trim trailing slashes off the configured base URL (may be empty in dev). */
function originOf(siteConfig = {}) {
  return (siteConfig.baseUrl || '').replace(/\/+$/, '')
}

/** Absolute URL when an origin is configured; otherwise the bare path. */
function url(origin, path) {
  return origin ? `${origin}${path}` : path
}

/**
 * robots.txt body: the content-signal preamble, the crawl policy with a
 * `Content-Signal` directive, and a sitemap pointer derived from the
 * configured base URL.
 *
 * @param {{ baseUrl?: string, contentSignal?: string }} [siteConfig]
 * @returns {string}
 */
export function buildRobotsTxt(siteConfig = {}) {
  const origin = originOf(siteConfig)
  const signal = contentSignal(siteConfig)
  return `# As a condition of accessing this website, you agree to abide by the following
# content signals:

# (a)  If a content-signal = yes, you may collect content for the corresponding
#      use.
# (b)  If a content-signal = no, you may not collect content for the
#      corresponding use.
# (c)  If the website operator does not include a content signal for a
#      corresponding use, the website operator neither grants nor restricts
#      permission via content signal with respect to the corresponding use.

# The content signals and their meanings are:

# search:   building a search index and providing search results (e.g., returning
#           hyperlinks and short excerpts from your website's contents). Search does not
#           include providing AI-generated search summaries.
# ai-input: inputting content into one or more AI models (e.g., retrieval
#           augmented generation, grounding, or other real-time taking of content for
#           generative AI search answers).
# ai-train: training or fine-tuning AI models.

# ANY RESTRICTIONS EXPRESSED VIA CONTENT SIGNALS ARE EXPRESS RESERVATIONS OF
# RIGHTS UNDER ARTICLE 4 OF THE EUROPEAN UNION DIRECTIVE 2019/790 ON COPYRIGHT
# AND RELATED RIGHTS IN THE DIGITAL SINGLE MARKET.

User-agent: *
Content-Signal: ${signal}
Allow: /
Disallow: /api/

# The same content signals are also delivered as a Content-Signal HTTP
# response header so spec-aware crawlers can read them per-response.

Sitemap: ${url(origin, '/sitemap.xml')}
`
}

/**
 * OpenSearch 1.1 description document. Lets browsers and spec-aware engines
 * register the site as a search source pointing at the same `/search?q=` URL
 * the SERP `SearchAction` JSON-LD uses. The address-bar/site-search path that
 * survived Google's 2024 deprecation of the sitelinks search box.
 *
 * `ShortName` is capped at the spec's 16-character limit.
 *
 * @param {{ baseUrl?: string, siteName?: string }} [siteConfig]
 * @returns {string} `application/opensearchdescription+xml` body
 */
export function buildOpenSearchXml(siteConfig = {}) {
  const origin = originOf(siteConfig)
  const longName = siteConfig.siteName || 'Apple Developer Docs'
  const shortName = (siteConfig.searchShortName || 'Apple Docs').slice(0, 16)
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  return `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${esc(shortName)}</ShortName>
  <LongName>${esc(longName)}</LongName>
  <Description>${esc(`Search ${longName}`)}</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Url type="text/html" method="get" template="${esc(url(origin, '/search?q={searchTerms}'))}"/>
  <Url type="application/opensearchdescription+xml" rel="self" template="${esc(url(origin, '/opensearch.xml'))}"/>
</OpenSearchDescription>
`
}

/**
 * RFC 9727 API catalog as an RFC 9264 linkset. Anchored at the site root,
 * it points crawlers and agents at the human docs (`service-doc`), the
 * health probe (`status`), the JSON API surface (`item`), and the MCP
 * server card (`related`).
 *
 * @param {{ baseUrl?: string }} [siteConfig]
 * @returns {object} `application/linkset+json` payload.
 */
export function buildApiCatalog(siteConfig = {}) {
  const origin = originOf(siteConfig)
  return {
    linkset: [
      {
        anchor: url(origin, '/'),
        'service-doc': [
          { href: url(origin, '/docs/'), title: 'Apple Developer Docs', type: 'text/html' },
        ],
        status: [
          { href: url(origin, '/readyz'), type: 'application/json' },
        ],
        item: [
          { href: url(origin, '/api/search'), title: 'Documentation search', type: 'application/json' },
          { href: url(origin, '/api/filters'), title: 'Search filter facets', type: 'application/json' },
          { href: url(origin, '/api/symbols/search'), title: 'SF Symbols search', type: 'application/json' },
          { href: url(origin, '/api/fonts'), title: 'Apple fonts catalog', type: 'application/json' },
          { href: url(origin, '/api/fonts/faces.css'), title: 'Apple fonts @font-face sheet', type: 'text/css' },
        ],
        related: [
          {
            href: url(origin, '/.well-known/mcp/server-card.json'),
            title: 'MCP Server Card',
            type: 'application/json',
          },
        ],
      },
    ],
  }
}

/**
 * Cloudflare Pages / Netlify `_headers` file. Mirrors the headers the Bun
 * server injects (Link set, Vary: Accept, Content-Signal) onto a static CDN
 * deploy that has no origin server, plus the correct `application/linkset+json`
 * type for the extension-less api-catalog file.
 *
 * @param {{ baseUrl?: string, contentSignal?: string }} [siteConfig]
 * @returns {string}
 */
export function buildHeadersFile(siteConfig = {}) {
  return `/*
  Link: ${DISCOVERY_LINKS}
  Vary: Accept
  Content-Signal: ${contentSignal(siteConfig)}

/.well-known/api-catalog
  Content-Type: application/linkset+json
`
}

/**
 * MCP server card: identity, transport, capabilities, and the tool /
 * resource-template name lists so an agent can decide whether to connect
 * without opening a session.
 *
 * @param {{ baseUrl?: string }} [siteConfig]
 * @param {string} version
 * @returns {object}
 */
export function buildMcpServerCard(siteConfig = {}, version) {
  const origin = originOf(siteConfig)
  return {
    serverInfo: { name: 'apple-docs', version },
    description: 'Search and read Apple developer documentation offline: DocC API reference, HIG, App Store Review Guidelines, Swift Evolution, WWDC sessions, sample code, SF Symbols, and Apple fonts. Read-only tools, token-lean definitions.',
    transport: { type: 'streamable-http', endpoint: url(origin, '/mcp') },
    capabilities: ['tools', 'resources'],
    endpoints: {
      health: url(origin, '/healthz'),
      ready: url(origin, '/readyz'),
    },
    tools: [...MCP_TOOLS],
    resources: [...MCP_RESOURCE_TEMPLATES],
  }
}
