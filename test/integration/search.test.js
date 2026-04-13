import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { search } from '../../src/commands/search.js'
import { lookup } from '../../src/commands/lookup.js'
import { writeJSON } from '../../src/storage/files.js'
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'

let db
let ctx
let tmpDir

beforeAll(async () => {
  tmpDir = join(import.meta.dir, '..', '.tmp-integration-search')
  mkdirSync(join(tmpDir, 'raw-json', 'documentation', 'testfw'), { recursive: true })
  mkdirSync(join(tmpDir, 'markdown', 'documentation', 'testfw'), { recursive: true })

  db = new DocsDatabase(':memory:')
  ctx = {
    db,
    dataDir: tmpDir,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }

  // Seed a small corpus
  const root = db.upsertRoot('testfw', 'TestFramework', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/testfw/myview',
    url: 'u',
    title: 'MyView',
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: 'A custom test view for integration testing',
    declaration: 'struct MyView : View',
  })
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/testfw/mybutton',
    url: 'u',
    title: 'MyButton',
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: 'A custom button control',
    declaration: 'struct MyButton<Label> where Label : View',
  })

  // Write raw JSON for one page (to test fallback rendering in lookup)
  const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()
  await writeJSON(join(tmpDir, 'raw-json', 'documentation', 'testfw', 'myview.json'), fixture)
})

afterAll(() => {
  db.close()
  try { rmSync(tmpDir, { recursive: true }) } catch {}
})

describe('Integration: Search', () => {
  test('exact symbol search returns correct result', async () => {
    const result = await search({ query: 'MyView', limit: 10, fuzzy: true, noDeep: true }, ctx)
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0].path).toBe('documentation/testfw/myview')
    expect(result.results[0].title).toBe('MyView')
  })

  test('prefix search returns multiple results', async () => {
    const result = await search({ query: 'My', limit: 10, fuzzy: true, noDeep: true }, ctx)
    expect(result.results.length).toBe(2)
  })

  test('framework filter narrows results', async () => {
    const result = await search({ query: 'My', framework: 'testfw', limit: 10, fuzzy: true, noDeep: true }, ctx)
    expect(result.results.length).toBe(2)

    const result2 = await search({ query: 'My', framework: 'nonexistent', limit: 10, fuzzy: true, noDeep: true }, ctx)
    expect(result2.results.length).toBe(0)
  })

  test('abstract text is searchable', async () => {
    const result = await search({ query: 'integration testing', limit: 10, fuzzy: true, noDeep: true }, ctx)
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    expect(result.results[0].path).toBe('documentation/testfw/myview')
  })
})

describe('Integration: Lookup with Fallback', () => {
  test('lookup by path returns page', async () => {
    const result = await lookup({ path: 'documentation/testfw/myview' }, ctx)
    expect(result.found).toBe(true)
    expect(result.metadata.title).toBe('MyView')
  })

  test('lookup renders from raw JSON when markdown missing', async () => {
    // No markdown file exists initially, but raw JSON does
    // Note: with balanced profile caching, a prior lookup may have cached the file
    const result = await lookup({ path: 'documentation/testfw/myview', noCache: true }, ctx)
    expect(result.found).toBe(true)
    expect(result.content).not.toBeNull()
    // Should contain markdown-like content from the fixture
    expect(result.content).toContain('View')
  })

  test('lookup returns null content when neither markdown nor json exists', async () => {
    const result = await lookup({ path: 'documentation/testfw/mybutton' }, ctx)
    expect(result.found).toBe(true)
    expect(result.content).toBeNull()
    expect(result.note).toBe('No content available. Run apple-docs sync first.')
  })
})
