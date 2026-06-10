import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/mcp/server.js'
import { DocsDatabase } from '../../src/storage/database.js'
import { createLogger } from '../../src/lib/logger.js'

let db, server, client, dataDir

// Allowlist per tool — these are the ONLY top-level keys that may appear
// in a public-mode response. Any extra key is treated as a leak.
const ALLOWED = {
  search_docs: new Set([
    'query', 'total', 'results',
    'approximate', 'truncated',
    'pageInfo',
    // Doc-shaped variant (search --read)
    'found', 'metadata', 'content', 'sections', 'matches', 'note', 'bestMatch',
  ]),
  read_doc: new Set([
    'found', 'metadata', 'content', 'sections', 'matches', 'note', 'bestMatch', 'pageInfo',
  ]),
  list_frameworks: new Set(['roots', 'total', 'pageInfo']),
  browse: new Set(['framework', 'title', 'path', 'pages', 'children', 'total', 'pageInfo']),
  list_taxonomy: new Set(['kind', 'role', 'docKind', 'roleHeading', 'sourceType']),
  search_sf_symbols: new Set(['results']),
  list_apple_fonts: new Set(['families']),
  render_sf_symbol: new Set(['name', 'scope', 'format', 'resourceUri', 'svg']),
  render_font_text: new Set(['text', 'mimeType', 'content']),
}

const SEARCH_HIT_ALLOWED = new Set([
  'path', 'title', 'framework', 'rootSlug', 'kind', 'sourceType',
  'abstract', 'declaration', 'platforms', 'language',
  'snippet', 'relatedCount', 'confidence',
  'isDeprecated', 'isBeta', 'isReleaseNotes',
])

const METADATA_ALLOWED = new Set([
  'title', 'framework', 'rootSlug', 'roleHeading', 'kind',
  'abstract', 'declaration', 'path', 'platforms', 'relationships',
  'isDeprecated', 'isBeta', 'isReleaseNotes',
])

const PAGE_INFO_ALLOWED = new Set([
  'page', 'totalPages', 'hasNextPage', 'hasPreviousPage', 'totalItems',
])

// Infrastructure fields explicitly proven NOT to appear anywhere.
const INFRA_BLACKLIST = new Set([
  'matchQuality', 'distance', 'score',
  'tier', 'tierLimitation', 'trigramAvailable', 'bodyIndexAvailable',
  'relaxed', 'relaxationTier', 'partial', 'partialReasons',
  'urlDepth', 'sourceMetadata', 'intent',
  'sectionKind', 'sortOrder', 'section_kind', 'sort_order',
  'file_path', 'lastSeen', 'status', 'displayName',
])

function assertNoBlacklistedDeep(value, path = '$') {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoBlacklistedDeep(value[i], `${path}[${i}]`)
    }
    return
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (INFRA_BLACKLIST.has(key)) {
        throw new Error(`leak: infra field "${key}" appears at ${path}`)
      }
      assertNoBlacklistedDeep(value[key], `${path}.${key}`)
    }
  }
}

function assertTopLevelAllowlist(tool, payload) {
  const allowed = ALLOWED[tool]
  for (const key of Object.keys(payload)) {
    if (!allowed.has(key)) {
      throw new Error(`leak: ${tool} returned unexpected top-level field "${key}" — not in allowlist`)
    }
  }
}

function assertNestedAllowlist(value, allowed, path) {
  if (!value || typeof value !== 'object') return
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`leak: unexpected field "${key}" at ${path}`)
    }
  }
}

beforeEach(async () => {
  db = new DocsDatabase(':memory:')
  const swiftuiRoot = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  // The frameworks command lists roots by live page count, so the root
  // needs at least one active page to appear at all.
  db.upsertPage({
    rootId: swiftuiRoot.id,
    url: 'https://example.com/swiftui/view',
    path: 'swiftui/view',
    title: 'View',
    role: 'symbol',
    abstract: 'A type that represents part of your app\'s user interface.',
  })

  // Seed: View doc with relationships.
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc', key: 'swiftui/text', title: 'Text',
      kind: 'symbol', role: 'symbol', roleHeading: 'Structure', framework: 'swiftui',
      abstractText: 'A view that displays text.',
    },
    sections: [{ sectionKind: 'abstract', contentText: 'A view that displays text.', sortOrder: 0 }],
    relationships: [],
  })
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc', key: 'swiftui/view', title: 'View',
      kind: 'symbol', role: 'symbol', roleHeading: 'Protocol', framework: 'swiftui',
      abstractText: 'A type that represents part of your app\'s user interface.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app\'s user interface.', sortOrder: 0 },
      { sectionKind: 'discussion', heading: 'Overview', contentText: 'You create custom views.', sortOrder: 1 },
    ],
    relationships: [
      { fromKey: 'swiftui/view', toKey: 'swiftui/text', relationType: 'child', sortOrder: 0 },
    ],
  })

  // Use a real tmpdir for dataDir so the markdown/raw-json persistence
  // paths land somewhere safe. The previous literal `':memory:'` made
  // those helpers create a `:memory:/markdown/...` tree at the repo
  // root (CodeQL didn't flag it; the counter-audit caught it).
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-leak-guard-'))
  const logger = createLogger('error')
  const ctx = { db, dataDir, logger }
  server = createServer(ctx)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  client = new Client({ name: 'leak-guard', version: '1.0.0' }, {})
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client?.close()
  await server?.close()
  db?.close()
  if (dataDir) {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* tolerate */ }
    dataDir = undefined
  }
})

async function callTool(tool, args = {}) {
  const result = await client.callTool({ name: tool, arguments: args })
  return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? '{}')
}

describe('MCP leak guard — every tool response respects the allowlist', () => {
  test('search_docs', async () => {
    const out = await callTool('search_docs', { query: 'View', framework: 'swiftui' })
    assertTopLevelAllowlist('search_docs', out)
    assertNoBlacklistedDeep(out)
    for (const hit of out.results ?? []) {
      assertNestedAllowlist(hit, SEARCH_HIT_ALLOWED, `search_docs.results[*]`)
      expect(['exact', 'partial', 'approximate']).toContain(hit.confidence)
    }
    assertNestedAllowlist(out.pageInfo, PAGE_INFO_ALLOWED, 'search_docs.pageInfo')
  })

  test('search_docs with empty result', async () => {
    const out = await callTool('search_docs', { query: 'zzzzz-non-existent-zzzz' })
    assertTopLevelAllowlist('search_docs', out)
    assertNoBlacklistedDeep(out)
  })

  test('read_doc surfaces relationships counts in metadata only', async () => {
    const out = await callTool('read_doc', { path: 'swiftui/view' })
    assertTopLevelAllowlist('read_doc', out)
    assertNoBlacklistedDeep(out)
    assertNestedAllowlist(out.metadata, METADATA_ALLOWED, 'read_doc.metadata')
    expect(out.metadata.relationships).toBeDefined()
    expect(out.metadata.relationships.children).toBe(1)
  })

  test('read_doc found:false collapses correctly', async () => {
    const out = await callTool('read_doc', { path: 'nonexistent/path' })
    expect(out.found).toBe(false)
    assertTopLevelAllowlist('read_doc', out)
    assertNoBlacklistedDeep(out)
  })

  test('list_frameworks default returns ALL frameworks (no kind filter)', async () => {
    const out = await callTool('list_frameworks', {})
    assertTopLevelAllowlist('list_frameworks', out)
    assertNoBlacklistedDeep(out)
    expect(out.roots.length).toBeGreaterThan(0)
    for (const root of out.roots) {
      assertNestedAllowlist(root, new Set(['slug', 'name', 'kind', 'pageCount']), 'list_frameworks.roots[*]')
    }
  })

  test('browse a framework lists pages', async () => {
    const out = await callTool('browse', { framework: 'swiftui' })
    assertTopLevelAllowlist('browse', out)
    assertNoBlacklistedDeep(out)
    expect(out.framework).toBe('SwiftUI')
  })

  test('list_taxonomy default caps to top 20 per field', async () => {
    const out = await callTool('list_taxonomy', {})
    assertTopLevelAllowlist('list_taxonomy', out)
    assertNoBlacklistedDeep(out)
    for (const entries of Object.values(out)) {
      expect(entries.length).toBeLessThanOrEqual(20)
      for (const entry of entries) {
        expect(Object.keys(entry).sort()).toEqual(['count', 'value'])
      }
    }
  })

  test('list_taxonomy with all:true bypasses the cap', async () => {
    const out = await callTool('list_taxonomy', { all: true })
    assertTopLevelAllowlist('list_taxonomy', out)
    assertNoBlacklistedDeep(out)
  })

  test('list_taxonomy with field still respects allowlist', async () => {
    const out = await callTool('list_taxonomy', { field: 'kind' })
    assertTopLevelAllowlist('list_taxonomy', out)
    assertNoBlacklistedDeep(out)
    expect(Array.isArray(out.kind)).toBe(true)
  })
})
