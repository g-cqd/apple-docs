// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * Contract gate for the native MCP server (RFC 0005 Phase C, + the Phase-D2
 * scaffold). Boots `ad-server mcp` as a stdio subprocess (and the HTTP `POST /mcp`
 * transport), speaks newline-delimited JSON-RPC, and checks:
 *   - initialize: protocolVersion echo, serverInfo, capabilities, instructions;
 *   - tools/list: the implemented tools' name/description/annotations/execution +
 *     a structurally-coherent inputSchema (ADJSON @Schemable is structural — leaner
 *     than the SDK's zod schema by design, so the schema TEXT is not byte-gated);
 *   - tools/call: the result's structuredContent + content[0].text are INTRINSIC-
 *     identical to the JS command + projection (the parity oracle, imported directly).
 *
 * Phase D2 (the 3 heavy tools — read_doc / render_sf_symbol / render_font_text —
 * and the 4 apple-docs:// resources) is scaffolded against the same JS oracle but
 * SKIP-GATED on a top-level capability probe: each case skips until the live
 * server advertises that tool/resource, then activates automatically. search_docs'
 * schema is asserted forward-compatibly (its D2 read/maxChars/page/match fields are
 * added once advertised). Render call-parity additionally no-ops when the corpus
 * has no renderable assets, so it's ready for a real-asset runner.
 *
 * Skipped entirely when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browse } from '../../../src/commands/browse.js'
import { frameworks } from '../../../src/commands/frameworks.js'
import { lookup } from '../../../src/commands/lookup.js'
import { search } from '../../../src/commands/search.js'
import { taxonomy } from '../../../src/commands/taxonomy.js'
import { VERSION } from '../../../src/lib/version.js'
import { serializePayload } from '../../../src/mcp/pagination/text-utils.js'
import { MIN_PAGINATED_MAX_CHARS } from '../../../src/mcp/pagination.js'
import { sanitizeDocumentPayload } from '../../../src/mcp/server/helpers.js'
import {
  projectBrowse,
  projectFrameworks,
  projectListAppleFonts,
  projectReadDoc,
  projectRenderFontText,
  projectRenderSfSymbol,
  projectSearchResult,
  projectSearchSfSymbols,
  projectTaxonomy,
} from '../../../src/output/projection.js'
import { listAppleFonts, renderFontText, renderSfSymbol, SYMBOL_SCALES, SYMBOL_WEIGHTS, searchSfSymbols } from '../../../src/resources/apple-assets.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const INSTRUCTIONS =
  "Local offline index of Apple developer documentation: DocC frameworks, HIG, App Store Review Guidelines, Swift Evolution/book/org, WWDC sessions, sample code, Swift packages, SF Symbols, Apple fonts. Typical flow: search_docs, then read_doc with a hit's path (paginate long pages with maxChars). browse/list_frameworks explore structure; list_taxonomy enumerates filter values. All tools are read-only and fast."

// Shared draft-07 schema helpers + READ_ONLY annotations — used by both the
// Phase-C 6-tool assertion and the D2 heavy-tool assertions below.
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
const D7 = 'http://json-schema.org/draft-07/schema#'
const obj = (/** @type {any} */ properties, /** @type {any} */ required) => ({
  $schema: D7,
  type: 'object',
  properties,
  ...(required ? { required } : {}),
})
// The nested match-excerpt object (read_doc + search_docs' D2 fields). zod's
// matchExcerptSchema → a nested object whose only required key is `query`.
const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Substring to locate.' },
    context: { type: 'integer', minimum: 20, maximum: 2000, description: 'Chars around each match (default 140).' },
    max: { type: 'integer', minimum: 1, maximum: 50, description: 'Max excerpts (default 5).' },
    caseSensitive: { type: 'boolean' },
  },
  required: ['query'],
  description: 'Return only excerpt windows around matches instead of full content.',
}
// search_docs' Phase-D2 additions (read + pagination + match), spread onto the
// Phase-C schema when the native server advertises them (forward-compatible).
const SEARCH_DOCS_D2_FIELDS = {
  read: { type: 'boolean', description: "Inline the top result's full content." },
  maxChars: { type: 'integer', minimum: MIN_PAGINATED_MAX_CHARS, description: `Page size in chars (min ${MIN_PAGINATED_MAX_CHARS}).` },
  page: { type: 'integer', minimum: 1, description: '1-based page; needs maxChars.' },
  match: MATCH_SCHEMA,
}
// The three heavy tools' inputSchemas (RFC 0005 D2), derived from the JS zod
// oracle (src/mcp/tools/{docs,assets}.js). Same draft-07 conventions the
// Phase-C 6-tool assertion already verifies against the live server, so when
// the native twin lands these should match; if the @Schemable serialization
// differs the assertion is the place to reconcile.
const D2_TOOL_SCHEMAS = {
  read_doc: {
    desc: 'Read a documentation page as Markdown, by path or symbol name. Long pages: pass maxChars to paginate, section for one section, or match for excerpts.',
    schema: obj({
      path: { type: 'string', description: 'Page path, e.g. swiftui/view, app-store-review/3.1.' },
      symbol: { type: 'string', description: 'Symbol name, e.g. NavigationStack.' },
      framework: { type: 'string', description: 'Disambiguates symbol.' },
      section: { type: 'string', description: 'Single section by heading.' },
      maxChars: { type: 'integer', minimum: MIN_PAGINATED_MAX_CHARS, description: `Page size in chars (min ${MIN_PAGINATED_MAX_CHARS}).` },
      page: { type: 'integer', minimum: 1, description: '1-based page; needs maxChars.' },
      match: MATCH_SCHEMA,
    }),
  },
  render_sf_symbol: {
    desc: 'Render an SF Symbol to SVG (inlined) or PNG (fetch via returned resource URI).',
    schema: obj(
      {
        name: { type: 'string', description: 'Symbol name, e.g. pencil.and.sparkles.' },
        scope: { type: 'string', enum: ['public', 'private'], description: 'Default public.' },
        format: { type: 'string', enum: ['svg', 'png'], description: 'Default png.' },
        size: { type: 'integer', minimum: 8, maximum: 1024, description: 'Square size in px.' },
        color: { type: 'string', description: 'Foreground hex or "currentColor" (svg).' },
        background: { type: 'string', description: 'Background hex or "transparent".' },
        weight: { type: 'string', enum: SYMBOL_WEIGHTS, description: 'Public symbols only.' },
        scale: { type: 'string', enum: SYMBOL_SCALES, description: 'Public symbols only.' },
      },
      ['name'],
    ),
  },
  render_font_text: {
    desc: 'Render a text preview as SVG using an Apple font.',
    schema: obj(
      {
        fontId: { type: 'string', description: 'Id from list_apple_fonts.' },
        text: { type: 'string', description: 'Text to render.' },
        size: { type: 'integer', minimum: 8, maximum: 512, description: 'Point size.' },
      },
      ['fontId'],
    ),
  },
}

let dir
let db
let proc
let client
let httpProc
const HTTP_PORT = 3046
// D2 capability flags — set by the top-level probe once the binary is built.
let advertisedTools = new Set()
let listedResources = []
let resourceFrameworkReadable = false
let resourceDocReadable = false

function makeClient(child) {
  const decoder = new TextDecoder()
  let buffer = ''
  const waiters = []
  const ready = []
  ;(async () => {
    for await (const chunk of child.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const msg = JSON.parse(line)
        if (waiters.length) waiters.shift()(msg)
        else ready.push(msg)
      }
    }
  })()
  return {
    notify(message) {
      child.stdin.write(JSON.stringify(message) + '\n')
      child.stdin.flush()
    },
    request(message) {
      this.notify(message)
      if (ready.length) return Promise.resolve(ready.shift())
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

if (existsSync(AD_SERVER)) {
  dir = mkdtempSync(join(tmpdir(), 'mcp-parity-'))
  const dbPath = join(dir, 'corpus.db')
  const seed = new DocsDatabase(dbPath)
  seed.upsertRoot('swiftui', 'SwiftUI', 'framework', 'seed')
  seed.upsertRoot('uikit', 'UIKit', 'framework', 'seed')
  const DOCS = [
    {
      key: 'swiftui/view',
      title: 'View',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      roleHeading: 'Protocol',
      kind: 'protocol',
      language: 'swift',
      abstractText: 'A view.',
      urlDepth: 2,
    },
    {
      key: 'swiftui/stack',
      title: 'Stack',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      roleHeading: 'Structure',
      kind: 'struct',
      language: 'swift',
      abstractText: 'A stack.',
      urlDepth: 2,
    },
    {
      key: 'uikit/uiview',
      title: 'UIView',
      framework: 'uikit',
      sourceType: 'apple-docc',
      role: 'symbol',
      roleHeading: 'Class',
      kind: 'class',
      language: 'occ',
      abstractText: 'A uiview.',
      urlDepth: 2,
    },
    {
      key: 'wwdc/talk1',
      title: 'Talk 1',
      framework: 'wwdc',
      sourceType: 'wwdc',
      role: 'article',
      roleHeading: 'Session',
      kind: 'article',
      language: 'swift',
      abstractText: 'A talk.',
      urlDepth: 2,
    },
  ]
  for (const d of DOCS) seed.upsertDocument(d)
  // A content-bearing page: real document_sections drive the on-demand
  // Markdown render path (lookup renders from sections when no .md/raw exists),
  // so read_doc + the doc resource exercise non-null `content` (vs swiftui/view,
  // which stays the no-content/tier-note path). Distinct keys per consumer keep
  // each oracle `lookup` a fresh render (balanced profile caches .md on first
  // read, flipping a second read's fallback note — separate keys avoid that).
  const CONTENT_SECTIONS = [
    { sectionKind: 'abstract', heading: null, contentText: 'A view that displays one or more lines of read-only text.', contentJson: null, sortOrder: 0 },
    {
      sectionKind: 'declaration',
      heading: null,
      contentText: '',
      contentJson: JSON.stringify([{ languages: ['swift'], tokens: [{ text: '@frozen ' }, { text: 'struct Text' }] }]),
      sortOrder: 1,
    },
    {
      sectionKind: 'discussion',
      heading: 'Overview',
      contentText: 'A text view draws a string in your app’s UI.\n\nUse it for labels and short, read-only content.',
      contentJson: null,
      sortOrder: 2,
    },
    {
      sectionKind: 'topics',
      heading: null,
      contentText: '',
      contentJson: JSON.stringify([{ title: 'Creating a Text View', items: [{ key: 'swiftui/text/init', title: 'init(_:)' }] }]),
      sortOrder: 3,
    },
  ]
  for (const key of ['swiftui/text', 'swiftui/label']) {
    const { id } = seed.upsertDocument({
      key,
      title: key === 'swiftui/text' ? 'Text' : 'Label',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      roleHeading: 'Structure',
      kind: 'struct',
      language: 'swift',
      abstractText: 'A view that displays one or more lines of read-only text.',
      platformsJson: { ios: '13.0', macos: '10.15' },
      urlDepth: 2,
    })
    seed.replaceDocumentSections(id, CONTENT_SECTIONS)
  }
  // Fonts.
  seed.assetsFonts.upsertFontFamily({ id: 'sf-pro', displayName: 'SF Pro' })
  seed.assetsFonts.upsertFontFamily({ id: 'ny', displayName: 'New York' })
  seed.assetsFonts.upsertFontFile({ id: 'sf-pro-bold', familyId: 'sf-pro', fileName: 'SF-Pro-Bold.otf', filePath: '/x/SF-Pro-Bold.otf', format: 'otf' })
  seed.assetsFonts.upsertFontFile({ id: 'ny-regular', familyId: 'ny', fileName: 'NewYork.ttf', filePath: '/x/NewYork.ttf', format: 'ttf' })
  // SF Symbols.
  seed.assetsSymbols.upsertSymbol({
    name: 'square.grid.2x2',
    scope: 'public',
    categories: ['ui', 'grid'],
    keywords: ['square', 'grid'],
    aliases: [],
    availability: { ios: '14.0' },
    orderIndex: 0,
    bundlePath: 'sym/sq',
    bundleVersion: '14.6',
  })
  seed.assetsSymbols.upsertSymbol({
    name: 'circle.fill',
    scope: 'public',
    categories: ['shapes'],
    keywords: ['circle'],
    aliases: ['filled.circle'],
    availability: { ios: '13.0' },
    orderIndex: 1,
    bundlePath: 'sym/ci',
    bundleVersion: '13.0',
  })
  seed.assetsSymbols.upsertSymbol({ name: 'lock.shield', scope: 'private', categories: [], keywords: ['lock'], aliases: [], availability: null, orderIndex: 0 })
  // A root with active pages so list_frameworks returns it (zero-page roots excluded).
  seed.upsertRoot('treefw', 'TreeFW', 'framework', 'seed')
  const treeRootId = seed.getRootBySlug('treefw').id
  for (const [path, title] of [
    ['treefw', 'TreeFW'],
    ['treefw/childa', 'ChildA'],
    ['treefw/childb', 'ChildB'],
  ]) {
    seed.upsertPage({ rootId: treeRootId, path, url: `https://x/${path}`, title, role: 'symbol', roleHeading: 'Class' })
  }
  seed.db.run("UPDATE documents SET framework = 'treefw' WHERE key LIKE 'treefw%'")
  // Make swiftui docs browsable (pages + a child relationship) for the browse tool.
  const sfRootId = seed.getRootBySlug('swiftui').id
  seed.upsertPage({ rootId: sfRootId, path: 'swiftui/view', url: 'https://x/swiftui/view', title: 'View', role: 'symbol', roleHeading: 'Protocol' })
  seed.upsertPage({ rootId: sfRootId, path: 'swiftui/stack', url: 'https://x/swiftui/stack', title: 'Stack', role: 'symbol', roleHeading: 'Structure' })
  seed.replaceDocumentRelationships('swiftui/view', [{ toKey: 'swiftui/stack', relationType: 'child', section: 'Topics' }])
  seed.close()
  db = new DocsDatabase(dbPath)
  proc = Bun.spawn([AD_SERVER, 'mcp', '--db', dbPath, '--app-version', VERSION], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  })
  client = makeClient(proc)
  // The default (HTTP) server also serves POST /mcp (the second transport).
  httpProc = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(HTTP_PORT), '--app-version', VERSION], { stdout: 'ignore', stderr: 'ignore' })
}

// RFC 0005 Phase D2 capability probe: learn which heavy tools + resources the
// native server advertises so the matrix below SKIPS (not fails) until the
// operator lands them. Probed once over stdio — capabilities are transport-
// independent (POST /mcp shares the same dispatcher).
if (existsSync(AD_SERVER)) {
  await client.request({
    jsonrpc: '2.0',
    id: 900,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
  })
  client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  const toolsList = await client.request({ jsonrpc: '2.0', id: 901, method: 'tools/list' })
  advertisedTools = new Set((toolsList.result?.tools ?? []).map((/** @type {any} */ t) => t.name))
  const resourcesList = await client.request({ jsonrpc: '2.0', id: 902, method: 'resources/list' })
  listedResources = Array.isArray(resourcesList.result?.resources) ? resourcesList.result.resources : []
  // Per-resource probes: each apple-docs:// template lands independently, so gate
  // its parity test on whether a read returns contents (vs the -32002 not-found).
  const fwRead = await client.request({ jsonrpc: '2.0', id: 903, method: 'resources/read', params: { uri: 'apple-docs://framework/swiftui' } })
  resourceFrameworkReadable = Array.isArray(fwRead.result?.contents)
  const docRead = await client.request({ jsonrpc: '2.0', id: 904, method: 'resources/read', params: { uri: 'apple-docs://doc/swiftui/view' } })
  resourceDocReadable = Array.isArray(docRead.result?.contents)
}
const HAS_READ_DOC = advertisedTools.has('read_doc')
const HAS_RENDER_SYMBOL = advertisedTools.has('render_sf_symbol')
const HAS_RENDER_FONT = advertisedTools.has('render_font_text')
const HAS_RESOURCES = listedResources.length > 0
const HAS_RESOURCE_FRAMEWORK = resourceFrameworkReadable
const HAS_RESOURCE_DOC = resourceDocReadable

describe.skipIf(!existsSync(AD_SERVER))('mcp parity (ad-server mcp == JS MCP tools)', () => {
  beforeAll(async () => {
    // initialize handshake.
    await client.request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  afterAll(() => {
    proc?.kill()
  })

  test('initialize — serverInfo + protocolVersion + capabilities + instructions', async () => {
    const res = await client.request({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    })
    expect(res.jsonrpc).toBe('2.0')
    expect(res.id).toBe(2)
    expect(res.result.protocolVersion).toBe('2025-06-18') // echoed (supported)
    expect(res.result.serverInfo).toEqual({ name: 'apple-docs', version: VERSION })
    expect(res.result.capabilities).toEqual({ resources: { listChanged: true }, tools: { listChanged: true } })
    expect(res.result.instructions).toBe(INSTRUCTIONS)
  })

  test('ping — empty result', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 3, method: 'ping' })
    expect(res.result).toEqual({})
  })

  test('tools/list — metadata + draft-07 inputSchema (deep-equal vs zod)', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
    const byName = Object.fromEntries(res.result.tools.map((t) => [t.name, t]))
    // READ_ONLY / D7 / obj are module-level (shared with the D2 assertions).
    // search_docs's read/maxChars/page/match ride Phase D2 → omitted here, then
    // spread in below once the live server advertises them (forward-compatible).
    const EXPECTED = {
      search_docs: {
        desc: "Search Apple developer docs (keyword + semantic). Prefer compact symbol/API terms; put constraints in filter args, not the query. Set read=true to inline the top hit's content.",
        schema: obj(
          {
            query: { type: 'string', description: 'Search terms, e.g. "NavigationStack".' },
            framework: { type: 'string', description: 'Framework slug, e.g. swiftui, app-store-review.' },
            source: { type: 'string', description: 'Source slug(s), comma-separated: apple-docc, hig, wwdc, sample-code, swift-evolution, ...' },
            kind: { type: 'string', description: 'Page kind (values via list_taxonomy).' },
            language: { type: 'string', enum: ['swift', 'objc'] },
            platform: { type: 'string', enum: ['ios', 'macos', 'watchos', 'tvos', 'visionos'] },
            minVersion: {
              type: 'object',
              properties: {
                ios: { type: 'string' },
                macos: { type: 'string' },
                watchos: { type: 'string' },
                tvos: { type: 'string' },
                visionos: { type: 'string' },
              },
              description: 'Min version per platform, e.g. {"ios":"17.0"}.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 25).' },
            year: { type: 'number', description: 'WWDC session year.' },
            track: { type: 'string', description: 'WWDC track.' },
            deprecated: { type: 'string', enum: ['include', 'exclude', 'only'], description: 'Default include; use exclude when writing code.' },
          },
          ['query'],
        ),
      },
      list_taxonomy: {
        desc: 'List distinct taxonomy values with counts (top 20 per field). Use to pick valid search_docs kind filters.',
        schema: obj({
          field: { type: 'string', enum: ['kind', 'role', 'docKind', 'roleHeading', 'sourceType'], description: 'Single field instead of all five.' },
          all: { type: 'boolean', description: 'Full distribution, not top 20.' },
        }),
      },
      list_frameworks: {
        desc: 'List indexed documentation roots (frameworks, HIG, guidelines, WWDC, tooling, ...) with page counts.',
        schema: obj({
          kind: { type: 'string', description: 'Filter: framework, technology, tooling, collection, release-notes, tutorial, guidelines, design.' },
          maxChars: { type: 'integer', minimum: 512, description: 'Page size in chars (min 512).' },
          page: { type: 'integer', minimum: 1, description: '1-based page; needs maxChars.' },
        }),
      },
      search_sf_symbols: {
        desc: 'Search SF Symbols by name, category, alias, or keyword.',
        schema: obj({
          query: { type: 'string', description: 'Name or keyword; empty lists all.' },
          scope: { type: 'string', enum: ['public', 'private'] },
          limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Max results (default 100).' },
        }),
      },
      list_apple_fonts: {
        desc: 'List Apple font families and files (ids feed render_font_text).',
        schema: obj({}),
      },
      browse: {
        desc: "Walk the documentation topic tree: a root's pages, or one page's children via path. wwdc root returns per-year groups; pass year for that year's sessions.",
        schema: obj(
          {
            framework: { type: 'string', description: 'Root slug, e.g. swiftui, design, wwdc.' },
            path: { type: 'string', description: 'Drill into a page, e.g. swiftui/view.' },
            year: { type: 'integer', description: 'WWDC sessions of one year.' },
            limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max pages (default 100, cap 200).' },
          },
          ['framework'],
        ),
      },
    }
    // Phase-D2: search_docs gains read/maxChars/page/match. Assert the fuller
    // schema once the live server advertises them; until then this is a no-op.
    if (byName.search_docs?.inputSchema?.properties?.read) {
      Object.assign(EXPECTED.search_docs.schema.properties, SEARCH_DOCS_D2_FIELDS)
    }
    for (const [name, { desc, schema }] of Object.entries(EXPECTED)) {
      const t = byName[name]
      expect(t, `tool ${name} present`).toBeDefined()
      expect(t.description).toBe(desc)
      expect(t.annotations).toEqual(READ_ONLY)
      expect(t.execution).toEqual({ taskSupport: 'forbidden' })
      expect(t.inputSchema, `${name} inputSchema`).toEqual(schema)
    }
  })

  // tools/call — structuredContent + content text intrinsic-equal to JS command+projection.
  async function callTool(id, name, args = {}) {
    const res = await client.request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
    expect(res.result.isError).toBeUndefined()
    expect(JSON.parse(res.result.content[0].text)).toEqual(res.result.structuredContent)
    return res.result.structuredContent
  }

  async function readResource(id, uri) {
    const res = await client.request({ jsonrpc: '2.0', id, method: 'resources/read', params: { uri } })
    expect(res.result, `resources/read ${uri}`).toBeDefined()
    return res.result
  }

  // The JS render oracle, or null when this env has no renderable assets (the
  // synthetic corpus). Keeps render call-parity ready for a real-asset runner.
  async function sfSymbolOracle(/** @type {any} */ args) {
    try {
      const render = await renderSfSymbol(args, { db, dataDir: dir })
      const payload = {
        ...render,
        resourceUri: `apple-docs://sf-symbol/${render.scope}/${encodeURIComponent(render.name)}.${render.format}`,
      }
      if (render.format === 'svg') payload.svg = await Bun.file(render.file_path).text()
      return projectRenderSfSymbol(payload)
    } catch {
      return null
    }
  }

  test('tools/call list_taxonomy == projectTaxonomy(taxonomy())', async () => {
    const got = await callTool(10, 'list_taxonomy', {})
    expect(got).toEqual(projectTaxonomy(await taxonomy({}, { db })))
  })

  test('tools/call list_taxonomy field=kind', async () => {
    const got = await callTool(11, 'list_taxonomy', { field: 'kind' })
    expect(got).toEqual(projectTaxonomy(await taxonomy({ field: 'kind' }, { db })))
  })

  test('tools/call list_frameworks == projectFrameworks(frameworks())', async () => {
    const got = await callTool(12, 'list_frameworks', {})
    expect(got).toEqual(projectFrameworks(await frameworks({}, { db })))
  })

  test('tools/call search_sf_symbols == projectSearchSfSymbols(searchSfSymbols())', async () => {
    const got = await callTool(13, 'search_sf_symbols', {})
    expect(got).toEqual(projectSearchSfSymbols(searchSfSymbols('', {}, { db })))
  })

  test('tools/call list_apple_fonts == projectListAppleFonts(listAppleFonts())', async () => {
    const got = await callTool(14, 'list_apple_fonts', {})
    expect(got).toEqual(projectListAppleFonts(listAppleFonts({ db })))
  })

  test('tools/call search_docs == projectSearchResult(search(), webPaths:false)', async () => {
    const got = await callTool(16, 'search_docs', { query: 'view', limit: 10 })
    const result = await search({ query: 'view', limit: 10, offset: 0 }, { db })
    expect(got).toEqual(projectSearchResult(result, { webPaths: false }))
  })

  test('tools/call browse (pages) == projectBrowse(browse())', async () => {
    const got = await callTool(17, 'browse', { framework: 'swiftui' })
    expect(got).toEqual(projectBrowse(await browse({ framework: 'swiftui', defaultLimit: 100 }, { db })))
  })

  test('tools/call browse (children via path) == projectBrowse(browse(path))', async () => {
    const got = await callTool(18, 'browse', { framework: 'swiftui', path: 'swiftui/view' })
    expect(got).toEqual(projectBrowse(await browse({ framework: 'swiftui', path: 'swiftui/view', defaultLimit: 100 }, { db })))
  })

  test('tools/call browse unknown framework → isError', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 19, method: 'tools/call', params: { name: 'browse', arguments: { framework: 'zzz-nonexistent' } } })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toBe('Unknown framework: zzz-nonexistent')
  })

  test('unknown method → -32601', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 15, method: 'nope/nope' })
    expect(res.error.code).toBe(-32601)
  })

  // ---- RFC 0005 Phase D2: heavy tools + resources (skip until advertised) ----

  test.skipIf(!HAS_READ_DOC)('tools/list — read_doc schema (deep-equal vs zod)', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 40, method: 'tools/list' })
    const t = res.result.tools.find((/** @type {any} */ x) => x.name === 'read_doc')
    expect(t).toBeDefined()
    expect(t.description).toBe(D2_TOOL_SCHEMAS.read_doc.desc)
    expect(t.annotations).toEqual(READ_ONLY)
    expect(t.inputSchema).toEqual(D2_TOOL_SCHEMAS.read_doc.schema)
  })

  test.skipIf(!HAS_RENDER_SYMBOL)('tools/list — render_sf_symbol schema (deep-equal vs zod)', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 41, method: 'tools/list' })
    const t = res.result.tools.find((/** @type {any} */ x) => x.name === 'render_sf_symbol')
    expect(t).toBeDefined()
    expect(t.description).toBe(D2_TOOL_SCHEMAS.render_sf_symbol.desc)
    expect(t.annotations).toEqual(READ_ONLY)
    expect(t.inputSchema).toEqual(D2_TOOL_SCHEMAS.render_sf_symbol.schema)
  })

  test.skipIf(!HAS_RENDER_FONT)('tools/list — render_font_text schema (deep-equal vs zod)', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 42, method: 'tools/list' })
    const t = res.result.tools.find((/** @type {any} */ x) => x.name === 'render_font_text')
    expect(t).toBeDefined()
    expect(t.description).toBe(D2_TOOL_SCHEMAS.render_font_text.desc)
    expect(t.annotations).toEqual(READ_ONLY)
    expect(t.inputSchema).toEqual(D2_TOOL_SCHEMAS.render_font_text.schema)
  })

  test.skipIf(!HAS_READ_DOC)('tools/call read_doc == projectReadDoc(lookup())', async () => {
    const got = await callTool(43, 'read_doc', { path: 'swiftui/view' })
    const result = await lookup({ path: 'swiftui/view', includeSections: false }, { db, dataDir: dir })
    expect(got).toEqual(projectReadDoc(sanitizeDocumentPayload(result), { full: false }))
  })

  test.skipIf(!HAS_READ_DOC)('tools/call read_doc unknown path → found:false parity', async () => {
    const got = await callTool(44, 'read_doc', { path: 'zzz/nonexistent' })
    const result = await lookup({ path: 'zzz/nonexistent', includeSections: false }, { db, dataDir: dir })
    expect(got).toEqual(projectReadDoc(sanitizeDocumentPayload(result), { full: false }))
  })

  // Content-bearing parity: swiftui/text has real document_sections, so lookup
  // renders Markdown on-demand → non-null `content` + the on-demand-fallback
  // note. The native render (ADContent DocMarkdown) must reproduce the same
  // bytes the JS renderMarkdown oracle produces (content + note byte-match).
  test.skipIf(!HAS_READ_DOC)('tools/call read_doc (content-bearing) == projectReadDoc(lookup())', async () => {
    const got = await callTool(50, 'read_doc', { path: 'swiftui/text' })
    const result = await lookup({ path: 'swiftui/text', includeSections: false }, { db, dataDir: dir })
    expect(result.content).toBeTruthy() // guard: the seed actually rendered content
    expect(got).toEqual(projectReadDoc(sanitizeDocumentPayload(result), { full: false }))
  })

  test.skipIf(!HAS_RENDER_SYMBOL)('tools/call render_sf_symbol == oracle (when renderable)', async () => {
    const oracle = await sfSymbolOracle({ name: 'square.grid.2x2', scope: 'public', format: 'svg' })
    if (!oracle) return // synthetic corpus can't render — ready for a real-asset env
    const got = await callTool(45, 'render_sf_symbol', { name: 'square.grid.2x2', scope: 'public', format: 'svg' })
    expect(got).toEqual(oracle)
  })

  test.skipIf(!HAS_RENDER_FONT)('tools/call render_font_text == oracle (when font on disk)', async () => {
    let oracle
    try {
      oracle = projectRenderFontText(await renderFontText({ fontId: 'sf-pro-bold', text: 'Hi', size: 32 }, { db, dataDir: dir }))
    } catch {
      return // no font file on disk — ready for a real-asset env
    }
    const got = await callTool(46, 'render_font_text', { fontId: 'sf-pro-bold', text: 'Hi', size: 32 })
    expect(got).toEqual(oracle)
  })

  test.skipIf(!HAS_RESOURCES)('resources/list == framework roots (projectFrameworks)', async () => {
    const res = await client.request({ jsonrpc: '2.0', id: 47, method: 'resources/list' })
    const roots = projectFrameworks(await frameworks({}, { db })).roots
    const expected = roots.map((/** @type {any} */ r) => ({ uri: `apple-docs://framework/${r.slug}`, name: r.name ?? r.slug }))
    const got = res.result.resources.map((/** @type {any} */ r) => ({ uri: r.uri, name: r.name }))
    expect(got).toEqual(expected)
  })

  test.skipIf(!HAS_RESOURCE_DOC)('resources/read apple-docs://doc/<key> == lookup text', async () => {
    const uri = 'apple-docs://doc/swiftui/view'
    const got = await readResource(48, uri)
    const result = await lookup({ path: 'swiftui/view' }, { db, dataDir: dir })
    const projected = projectReadDoc(sanitizeDocumentPayload(result), { full: false })
    const text = projected.found === false ? (projected.note ?? 'Not found') : (result.content ?? result.note ?? 'Not found')
    expect(got.contents[0].uri).toBe(uri)
    expect(got.contents[0].mimeType).toBe('text/markdown')
    expect(got.contents[0].text).toBe(text)
  })

  // Content-bearing doc resource: swiftui/label renders Markdown from sections,
  // so the resource body is that rendered content (JS: content ?? note), not the
  // tier note. Byte-matches the native render.
  test.skipIf(!HAS_RESOURCE_DOC)('resources/read apple-docs://doc/<key> (content-bearing) == rendered content', async () => {
    const uri = 'apple-docs://doc/swiftui/label'
    const got = await readResource(51, uri)
    const result = await lookup({ path: 'swiftui/label' }, { db, dataDir: dir })
    const projected = projectReadDoc(sanitizeDocumentPayload(result), { full: false })
    const text = projected.found === false ? (projected.note ?? 'Not found') : (result.content ?? result.note ?? 'Not found')
    expect(result.content).toBeTruthy() // guard: rendered content, not the tier note
    expect(got.contents[0].uri).toBe(uri)
    expect(got.contents[0].mimeType).toBe('text/markdown')
    expect(got.contents[0].text).toBe(text)
  })

  test.skipIf(!HAS_RESOURCE_FRAMEWORK)('resources/read apple-docs://framework/<slug> == serializePayload(projectBrowse)', async () => {
    const uri = 'apple-docs://framework/swiftui'
    const got = await readResource(49, uri)
    const result = await browse({ framework: 'swiftui' }, { db })
    expect(got.contents[0].uri).toBe(uri)
    expect(got.contents[0].mimeType).toBe('application/json')
    expect(got.contents[0].text).toBe(serializePayload(projectBrowse(result)))
  })
})

describe.skipIf(!existsSync(AD_SERVER))('mcp over HTTP (POST /mcp == same dispatcher)', () => {
  let httpReady = false
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) {
          httpReady = true
          break
        }
      } catch {}
      await Bun.sleep(80)
    }
  })
  afterAll(() => {
    httpProc?.kill()
    db?.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  function mcpPost(message, headers = {}) {
    return fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(message),
    })
  }

  test('http server reachable', () => {
    expect(httpReady).toBe(true)
  })

  test('POST /mcp initialize', async () => {
    const res = await mcpPost({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const json = await res.json()
    expect(json.result.serverInfo).toEqual({ name: 'apple-docs', version: VERSION })
    expect(json.result.protocolVersion).toBe('2025-06-18')
  })

  test('POST /mcp tools/call == projection (same dispatcher as stdio)', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_sf_symbols', arguments: {} } })
    const json = await res.json()
    expect(json.result.structuredContent).toEqual(projectSearchSfSymbols(searchSfSymbols('', {}, { db })))
  })

  test('POST /mcp origin denied → 403 + -32000', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 3, method: 'ping' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe(-32000)
  })

  test('OPTIONS /mcp preflight → 204 + CORS', async () => {
    const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/mcp`, { method: 'OPTIONS' })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })

  // ---- Phase D2 over HTTP (same dispatcher; skip until advertised) ----

  async function httpCall(/** @type {number} */ id, /** @type {string} */ method, /** @type {any} */ params) {
    const res = await mcpPost({ jsonrpc: '2.0', id, method, params })
    return (await res.json()).result
  }

  test.skipIf(!HAS_READ_DOC)('POST /mcp tools/call read_doc == oracle', async () => {
    const r = await httpCall(40, 'tools/call', { name: 'read_doc', arguments: { path: 'swiftui/view' } })
    const result = await lookup({ path: 'swiftui/view', includeSections: false }, { db, dataDir: dir })
    expect(r.structuredContent).toEqual(projectReadDoc(sanitizeDocumentPayload(result), { full: false }))
  })

  test.skipIf(!HAS_RESOURCES)('POST /mcp resources/list == framework roots', async () => {
    const r = await httpCall(41, 'resources/list', {})
    const roots = projectFrameworks(await frameworks({}, { db })).roots
    const expected = roots.map((/** @type {any} */ x) => ({ uri: `apple-docs://framework/${x.slug}`, name: x.name ?? x.slug }))
    expect(r.resources.map((/** @type {any} */ x) => ({ uri: x.uri, name: x.name }))).toEqual(expected)
  })

  test.skipIf(!HAS_RESOURCE_DOC)('POST /mcp resources/read doc == lookup text', async () => {
    const uri = 'apple-docs://doc/swiftui/view'
    const r = await httpCall(42, 'resources/read', { uri })
    const result = await lookup({ path: 'swiftui/view' }, { db, dataDir: dir })
    const projected = projectReadDoc(sanitizeDocumentPayload(result), { full: false })
    const text = projected.found === false ? (projected.note ?? 'Not found') : (result.content ?? result.note ?? 'Not found')
    expect(r.contents[0].text).toBe(text)
    expect(r.contents[0].mimeType).toBe('text/markdown')
  })
})
