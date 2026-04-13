import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createServer } from '../../src/mcp/server.js'
import { DocsDatabase } from '../../src/storage/database.js'
import { createLogger } from '../../src/lib/logger.js'

let db, server, client

beforeEach(async () => {
  db = new DocsDatabase(':memory:')

  // Seed minimal test data
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/view',
      title: 'View',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Protocol',
      framework: 'swiftui',
      abstractText: 'A type that represents part of your app\'s user interface.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A type that represents part of your app\'s user interface.', sortOrder: 0 },
      { sectionKind: 'declaration', contentText: 'protocol View', sortOrder: 1 },
    ],
    relationships: [
      { fromKey: 'swiftui/view', toKey: 'swiftui/text', relationType: 'child', section: 'Topics', sortOrder: 0 },
    ],
  })
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/text',
      title: 'Text',
      kind: 'symbol',
      role: 'symbol',
      roleHeading: 'Structure',
      framework: 'swiftui',
      abstractText: 'A view that displays one or more lines of read-only text.',
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'A view that displays one or more lines of read-only text.', sortOrder: 0 },
    ],
    relationships: [],
  })
  db.upsertRoot('wwdc', 'WWDC Session Transcripts', 'collection', 'test')
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'wwdc',
      key: 'wwdc/wwdc2024-10001',
      title: 'Meet Swift Testing',
      kind: 'wwdc-session',
      role: 'article',
      framework: 'wwdc',
      abstractText: 'Learn about the Swift Testing framework.',
      sourceMetadata: JSON.stringify({ year: 2024, sessionId: '10001', track: 'Testing' }),
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'Learn about the Swift Testing framework.', sortOrder: 0 },
    ],
    relationships: [],
  })
  db.upsertRoot('sample-code', 'Apple Sample Code', 'collection', 'test')
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'sample-code',
      key: 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app',
      title: 'Food Truck: Building a SwiftUI Multiplatform App',
      kind: 'sample-project',
      role: 'sampleCode',
      framework: 'swiftui',
      abstractText: 'Create a multiplatform SwiftUI sample app.',
      sourceMetadata: JSON.stringify({ sampleProject: true, frameworks: ['swiftui'] }),
    },
    sections: [
      { sectionKind: 'abstract', contentText: 'Create a multiplatform SwiftUI sample app.', sortOrder: 0 },
    ],
    relationships: [],
  })

  const logger = createLogger('error')
  const ctx = { db, dataDir: '/tmp/apple-docs-test', logger }

  server = createServer(ctx)
  client = new Client({ name: 'test-client', version: '1.0.0' })

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
})

afterEach(async () => {
  await client.close()
  await server.close()
  db.close()
})

describe('MCP contract — tools', () => {
  test('lists all 8 tools', async () => {
    const result = await client.listTools()
    const names = result.tools.map((t) => t.name).sort()
    expect(names).toEqual([
      'browse', 'list_frameworks', 'read_doc', 'read_sample_file',
      'search_docs', 'search_samples', 'search_wwdc', 'status',
    ])
  })

  test('each tool has a valid inputSchema', async () => {
    const result = await client.listTools()
    for (const tool of result.tools) {
      expect(tool.inputSchema).toBeDefined()
      expect(tool.inputSchema.type).toBe('object')
    }
  })

  test('search_docs returns results for a known query', async () => {
    const result = await client.callTool({ name: 'search_docs', arguments: { query: 'View' } })
    expect(result.isError).toBeFalsy()
    expect(result.content).toBeArray()
    expect(result.content[0].type).toBe('text')
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toBeArray()
    expect(parsed.results.length).toBeGreaterThan(0)
  })

  test('search_docs supports source filtering', async () => {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'Swift', source: 'wwdc' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toBeArray()
    expect(parsed.results[0].sourceType).toBe('wwdc')
  })

  test('search_docs accepts language and platform filters', async () => {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'View', language: 'swift', platform: 'ios' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toBeArray()
    expect(parsed.results.length).toBeGreaterThan(0)
  })

  test('search_docs accepts min_ios version filter without error', async () => {
    const result = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'View', min_ios: '13.0' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toBeArray()
  })

  test('search_docs with read returns content', async () => {
    const result = await client.callTool({ name: 'search_docs', arguments: { query: 'View', read: true } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.bestMatch).toBeDefined()
    expect(parsed.content).toBeDefined()
  })

  test('read_doc with known path returns document', async () => {
    const result = await client.callTool({ name: 'read_doc', arguments: { path: 'swiftui/view' } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.found).toBe(true)
    expect(parsed.metadata.title).toBe('View')
  })

  test('read_doc with unknown path returns not-found', async () => {
    const result = await client.callTool({ name: 'read_doc', arguments: { path: 'nonexistent/path' } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.found).toBe(false)
  })

  test('read_doc with symbol lookup', async () => {
    const result = await client.callTool({ name: 'read_doc', arguments: { symbol: 'Text', framework: 'swiftui' } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.found).toBe(true)
    expect(parsed.metadata.title).toBe('Text')
  })

  test('list_frameworks returns roots', async () => {
    const result = await client.callTool({ name: 'list_frameworks', arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.roots).toBeArray()
    expect(parsed.roots.length).toBeGreaterThan(0)
    expect(parsed.roots.map(root => root.slug)).toContain('swiftui')
  })

  test('browse returns framework pages', async () => {
    const result = await client.callTool({ name: 'browse', arguments: { framework: 'swiftui' } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toBeDefined()
  })

  test('browse with path shows children', async () => {
    const result = await client.callTool({ name: 'browse', arguments: { framework: 'swiftui', path: 'swiftui/view' } })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.children).toBeArray()
    expect(parsed.children.length).toBeGreaterThan(0)
  })

  test('status returns corpus info', async () => {
    const result = await client.callTool({ name: 'status', arguments: {} })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toBeDefined()
  })

  test('search_wwdc applies year filtering using source metadata', async () => {
    const result = await client.callTool({
      name: 'search_wwdc',
      arguments: { query: 'Swift Testing', year: 2024 },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].path).toBe('wwdc/wwdc2024-10001')
  })

  test('search_samples returns sample project results', async () => {
    const result = await client.callTool({
      name: 'search_samples',
      arguments: { query: 'Food Truck' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].sourceType).toBe('sample-code')
  })

  test('read_sample_file returns sample overview when file path is omitted', async () => {
    const result = await client.callTool({
      name: 'read_sample_file',
      arguments: { sample_key: 'sample-code/swiftui/food-truck-building-a-swiftui-multiplatform-app' },
    })
    expect(result.isError).toBeFalsy()
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.found).toBe(true)
    expect(parsed.metadata.title).toBe('Food Truck: Building a SwiftUI Multiplatform App')
    expect(parsed.sections).toBeArray()
  })
})

describe('MCP contract — resources', () => {
  test('lists resource templates', async () => {
    const result = await client.listResourceTemplates()
    const uris = result.resourceTemplates.map((t) => t.uriTemplate)
    expect(uris).toContain('apple-docs://doc/{+key}')
    expect(uris).toContain('apple-docs://framework/{slug}')
  })

  test('lists framework resources', async () => {
    const result = await client.listResources()
    const uris = result.resources.map((r) => r.uri)
    expect(uris).toContain('apple-docs://framework/swiftui')
  })

  test('reads doc resource', async () => {
    const result = await client.readResource({ uri: 'apple-docs://doc/swiftui/view' })
    expect(result.contents).toBeArray()
    expect(result.contents[0].uri).toBe('apple-docs://doc/swiftui/view')
    expect(result.contents[0].text).toBeDefined()
  })

  test('reads framework resource', async () => {
    const result = await client.readResource({ uri: 'apple-docs://framework/swiftui' })
    expect(result.contents).toBeArray()
    expect(result.contents[0].uri).toBe('apple-docs://framework/swiftui')
  })
})
