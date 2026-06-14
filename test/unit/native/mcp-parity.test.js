/**
 * Contract gate for the native MCP server (RFC 0005 Phase C). Boots `ad-server mcp`
 * as a stdio subprocess, speaks newline-delimited JSON-RPC, and checks:
 *   - initialize: protocolVersion echo, serverInfo, capabilities, instructions;
 *   - tools/list: the implemented tools' name/description/annotations/execution +
 *     a structurally-coherent inputSchema (ADJSON @Schemable is structural — leaner
 *     than the SDK's zod schema by design, so the schema TEXT is not byte-gated);
 *   - tools/call: the result's structuredContent + content[0].text are INTRINSIC-
 *     identical to the JS command + projection (the parity oracle, imported directly).
 *
 * Skipped when the release binary is absent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../../src/storage/database.js'
import { taxonomy } from '../../../src/commands/taxonomy.js'
import { frameworks } from '../../../src/commands/frameworks.js'
import { listAppleFonts, searchSfSymbols } from '../../../src/resources/apple-assets.js'
import { browse } from '../../../src/commands/browse.js'
import { search } from '../../../src/commands/search.js'
import {
  projectBrowse,
  projectFrameworks,
  projectListAppleFonts,
  projectSearchResult,
  projectSearchSfSymbols,
  projectTaxonomy,
} from '../../../src/output/projection.js'
import { VERSION } from '../../../src/lib/version.js'

const AD_SERVER = new URL('../../../swift/.build/release/ad-server', import.meta.url).pathname
const INSTRUCTIONS =
  "Local offline index of Apple developer documentation: DocC frameworks, HIG, App Store Review Guidelines, Swift Evolution/book/org, WWDC sessions, sample code, Swift packages, SF Symbols, Apple fonts. Typical flow: search_docs, then read_doc with a hit's path (paginate long pages with maxChars). browse/list_frameworks explore structure; list_taxonomy enumerates filter values. All tools are read-only and fast."

let dir
let db
let proc
let client
let httpProc
const HTTP_PORT = 3046

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
      return new Promise(resolve => waiters.push(resolve))
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
    { key: 'swiftui/view', title: 'View', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Protocol', kind: 'protocol', language: 'swift', abstractText: 'A view.', urlDepth: 2 },
    { key: 'swiftui/stack', title: 'Stack', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Structure', kind: 'struct', language: 'swift', abstractText: 'A stack.', urlDepth: 2 },
    { key: 'uikit/uiview', title: 'UIView', framework: 'uikit', sourceType: 'apple-docc', role: 'symbol', roleHeading: 'Class', kind: 'class', language: 'occ', abstractText: 'A uiview.', urlDepth: 2 },
    { key: 'wwdc/talk1', title: 'Talk 1', framework: 'wwdc', sourceType: 'wwdc', role: 'article', roleHeading: 'Session', kind: 'article', language: 'swift', abstractText: 'A talk.', urlDepth: 2 },
  ]
  for (const d of DOCS) seed.upsertDocument(d)
  // Fonts.
  seed.assetsFonts.upsertFontFamily({ id: 'sf-pro', displayName: 'SF Pro' })
  seed.assetsFonts.upsertFontFamily({ id: 'ny', displayName: 'New York' })
  seed.assetsFonts.upsertFontFile({ id: 'sf-pro-bold', familyId: 'sf-pro', fileName: 'SF-Pro-Bold.otf', filePath: '/x/SF-Pro-Bold.otf', format: 'otf' })
  seed.assetsFonts.upsertFontFile({ id: 'ny-regular', familyId: 'ny', fileName: 'NewYork.ttf', filePath: '/x/NewYork.ttf', format: 'ttf' })
  // SF Symbols.
  seed.assetsSymbols.upsertSymbol({ name: 'square.grid.2x2', scope: 'public', categories: ['ui', 'grid'], keywords: ['square', 'grid'], aliases: [], availability: { ios: '14.0' }, orderIndex: 0, bundlePath: 'sym/sq', bundleVersion: '14.6' })
  seed.assetsSymbols.upsertSymbol({ name: 'circle.fill', scope: 'public', categories: ['shapes'], keywords: ['circle'], aliases: ['filled.circle'], availability: { ios: '13.0' }, orderIndex: 1, bundlePath: 'sym/ci', bundleVersion: '13.0' })
  seed.assetsSymbols.upsertSymbol({ name: 'lock.shield', scope: 'private', categories: [], keywords: ['lock'], aliases: [], availability: null, orderIndex: 0 })
  // A root with active pages so list_frameworks returns it (zero-page roots excluded).
  seed.upsertRoot('treefw', 'TreeFW', 'framework', 'seed')
  const treeRootId = seed.getRootBySlug('treefw').id
  for (const [path, title] of [['treefw', 'TreeFW'], ['treefw/childa', 'ChildA'], ['treefw/childb', 'ChildB']]) {
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
    stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
  })
  client = makeClient(proc)
  // The default (HTTP) server also serves POST /mcp (the second transport).
  httpProc = Bun.spawn([AD_SERVER, '--db', dbPath, '--port', String(HTTP_PORT), '--app-version', VERSION], { stdout: 'ignore', stderr: 'ignore' })
}

describe.skipIf(!existsSync(AD_SERVER))('mcp parity (ad-server mcp == JS MCP tools)', () => {
  beforeAll(async () => {
    // initialize handshake.
    await client.request({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    })
    client.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  afterAll(() => {
    proc?.kill()
  })

  test('initialize — serverInfo + protocolVersion + capabilities + instructions', async () => {
    const res = await client.request({
      jsonrpc: '2.0', id: 2, method: 'initialize',
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
    const byName = Object.fromEntries(res.result.tools.map(t => [t.name, t]))
    const READ_ONLY = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
    const D7 = 'http://json-schema.org/draft-07/schema#'
    const obj = (properties, required) => ({ $schema: D7, type: 'object', properties, ...(required ? { required } : {}) })
    // search_docs's read/maxChars/page/match ride Phase D → omitted (subset of zod's schema).
    const EXPECTED = {
      search_docs: {
        desc: "Search Apple developer docs (keyword + semantic). Prefer compact symbol/API terms; put constraints in filter args, not the query. Set read=true to inline the top hit's content.",
        schema: obj({
          query: { type: 'string', description: 'Search terms, e.g. "NavigationStack".' },
          framework: { type: 'string', description: 'Framework slug, e.g. swiftui, app-store-review.' },
          source: { type: 'string', description: 'Source slug(s), comma-separated: apple-docc, hig, wwdc, sample-code, swift-evolution, ...' },
          kind: { type: 'string', description: 'Page kind (values via list_taxonomy).' },
          language: { type: 'string', enum: ['swift', 'objc'] },
          platform: { type: 'string', enum: ['ios', 'macos', 'watchos', 'tvos', 'visionos'] },
          minVersion: { type: 'object', properties: { ios: { type: 'string' }, macos: { type: 'string' }, watchos: { type: 'string' }, tvos: { type: 'string' }, visionos: { type: 'string' } }, description: 'Min version per platform, e.g. {"ios":"17.0"}.' },
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max results (default 25).' },
          year: { type: 'number', description: 'WWDC session year.' },
          track: { type: 'string', description: 'WWDC track.' },
          deprecated: { type: 'string', enum: ['include', 'exclude', 'only'], description: 'Default include; use exclude when writing code.' },
        }, ['query']),
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
        schema: obj({
          framework: { type: 'string', description: 'Root slug, e.g. swiftui, design, wwdc.' },
          path: { type: 'string', description: 'Drill into a page, e.g. swiftui/view.' },
          year: { type: 'integer', description: 'WWDC sessions of one year.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max pages (default 100, cap 200).' },
        }, ['framework']),
      },
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
})

describe.skipIf(!existsSync(AD_SERVER))('mcp over HTTP (POST /mcp == same dispatcher)', () => {
  let httpReady = false
  beforeAll(async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${HTTP_PORT}/healthz`)).ok) { httpReady = true; break } } catch {}
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
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(message),
    })
  }

  test('http server reachable', () => { expect(httpReady).toBe(true) })

  test('POST /mcp initialize', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } })
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
})
