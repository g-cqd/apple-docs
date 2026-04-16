import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import {
  generateSearchArtifacts,
  buildTitleIndex,
  buildAliasMap,
  buildBodyShards,
  writeSearchManifest,
} from '../../src/web/search-artifacts.js'

let db
let tmpDir

beforeEach(() => {
  db = new DocsDatabase(':memory:')
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-search-'))

  const now = new Date().toISOString()

  db.db.run(
    `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
     VALUES ('apple-docc', 'documentation/swiftui/view', 'View', 'symbol', 'swiftui',
             'A type that represents part of your app UI', ?, ?)`,
    [now, now],
  )
  db.db.run(
    `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
     VALUES ('apple-docc', 'documentation/foundation/url', 'URL', 'symbol', 'foundation',
             'A value that identifies the location of a resource', ?, ?)`,
    [now, now],
  )

  const viewId = db.db.query(
    "SELECT id FROM documents WHERE key = 'documentation/swiftui/view'",
  ).get().id

  db.db.run(
    `INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
     VALUES (?, 'discussion', 'Overview', 'SwiftUI views are the building blocks of your UI.', 0)`,
    [viewId],
  )
})

afterEach(() => {
  db.close()
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// buildTitleIndex
// ---------------------------------------------------------------------------

describe('buildTitleIndex', () => {
  test('returns v2 columnar object with frameworks and parallel arrays', () => {
    const result = buildTitleIndex(db)
    expect(result.v).toBe(2)
    expect(result).toHaveProperty('frameworks')
    expect(result).toHaveProperty('keys')
    expect(result).toHaveProperty('titles')
    expect(Array.isArray(result.frameworks)).toBe(true)
    expect(Array.isArray(result.keys)).toBe(true)
  })

  test('frameworks array contains all distinct frameworks sorted', () => {
    const { frameworks } = buildTitleIndex(db)
    expect(frameworks).toContain('foundation')
    expect(frameworks).toContain('swiftui')
    // Should be sorted
    const sorted = [...frameworks].sort()
    expect(frameworks).toEqual(sorted)
  })

  test('parallel arrays contain one entry per document', () => {
    const { keys } = buildTitleIndex(db)
    expect(keys).toHaveLength(2)
  })

  test('columnar arrays store key, title, abstract snippet, framework index, kind, role_heading', () => {
    const result = buildTitleIndex(db)
    const i = result.keys.indexOf('documentation/swiftui/view')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(result.titles[i]).toBe('View')
    expect(typeof result.abstracts[i]).toBe('string')
    expect(result.abstracts[i]).toBe('A type that represents part of your app UI') // 42 chars, under 80
    expect(result.fwIndices[i]).toBe(result.frameworks.indexOf('swiftui'))
    expect(result.kinds[i]).toBe('symbol')
    expect(result.roleHeadings[i]).toBe('') // not seeded
  })

  test('abstract snippet is truncated to 80 characters', () => {
    const now = new Date().toISOString()
    const longAbstract = 'A'.repeat(200)
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/corefoundation/cfstring', 'CFString', 'symbol', 'corefoundation', ?, ?, ?)`,
      [longAbstract, now, now],
    )

    const result = buildTitleIndex(db)
    const i = result.keys.indexOf('documentation/corefoundation/cfstring')
    expect(result.abstracts[i]).toHaveLength(80)
  })

  test('document with no framework gets framework index of -1', () => {
    const now = new Date().toISOString()
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/noframework/doc', 'NoFW', 'article', NULL, 'No framework', ?, ?)`,
      [now, now],
    )

    const result = buildTitleIndex(db)
    const i = result.keys.indexOf('documentation/noframework/doc')
    expect(result.fwIndices[i]).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// buildAliasMap
// ---------------------------------------------------------------------------

describe('buildAliasMap', () => {
  test('returns an object', () => {
    const result = buildAliasMap(db)
    expect(typeof result).toBe('object')
    expect(result).not.toBeNull()
  })

  test('maps aliases to their canonical framework names', () => {
    const aliasMap = buildAliasMap(db)
    // Schema seeds: quartzcore -> coreanimation alias, coreanimation -> quartzcore alias, etc.
    expect(aliasMap.coreanimation).toBe('quartzcore')
    expect(aliasMap.quartzcore).toBe('coreanimation')
    expect(aliasMap.quartz2d).toBe('coregraphics')
    expect(aliasMap.cocoa).toBe('appkit')
  })

  test('each value is a string canonical name', () => {
    const aliasMap = buildAliasMap(db)
    for (const [alias, canonical] of Object.entries(aliasMap)) {
      expect(typeof alias).toBe('string')
      expect(typeof canonical).toBe('string')
    }
  })
})

// ---------------------------------------------------------------------------
// buildBodyShards
// ---------------------------------------------------------------------------

describe('buildBodyShards', () => {
  test('creates a shards/ subdirectory in the output directory', async () => {
    await buildBodyShards(db, tmpDir)
    expect(existsSync(join(tmpDir, 'shards'))).toBe(true)
  })

  test('creates shard files in output directory with hashed names', async () => {
    const shardMeta = await buildBodyShards(db, tmpDir)
    const shardsDir = join(tmpDir, 'shards')
    const files = readdirSync(shardsDir)
    expect(files.length).toBeGreaterThan(0)
    expect(shardMeta.length).toBe(files.length)
    // Each file should have a content-hashed name
    for (const file of files) {
      expect(file).toMatch(/^[a-z_]\.[0-9a-f]{10}\.json$/)
    }
  })

  test('shard files are valid JSON objects keyed by document key', async () => {
    await buildBodyShards(db, tmpDir)
    const shardsDir = join(tmpDir, 'shards')
    const files = readdirSync(shardsDir)

    let foundViewKey = false
    for (const file of files) {
      const shard = await Bun.file(join(shardsDir, file)).json()
      expect(typeof shard).toBe('object')
      if ('documentation/swiftui/view' in shard) foundViewKey = true
    }

    expect(foundViewKey).toBe(true)
  })

  test('body text is truncated to 500 characters per document', async () => {
    // Insert a doc with a very long section
    const now = new Date().toISOString()
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/spritekit/sknode', 'SKNode', 'symbol', 'spritekit', 'SpriteKit node', ?, ?)`,
      [now, now],
    )
    const skId = db.db.query(
      "SELECT id FROM documents WHERE key = 'documentation/spritekit/sknode'",
    ).get().id
    db.db.run(
      `INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
       VALUES (?, 'discussion', 'Overview', ?, 0)`,
      [skId, 'X'.repeat(1000)],
    )

    await buildBodyShards(db, tmpDir)
    const shardsDir = join(tmpDir, 'shards')
    const files = readdirSync(shardsDir)

    let bodyValue = null
    for (const file of files) {
      const shard = await Bun.file(join(shardsDir, file)).json()
      if ('documentation/spritekit/sknode' in shard) {
        bodyValue = shard['documentation/spritekit/sknode']
        break
      }
    }

    expect(bodyValue).not.toBeNull()
    expect(bodyValue.length).toBeLessThanOrEqual(500)
  })

  test('documents with no section body are omitted from shards', async () => {
    // foundation/url has no sections seeded
    await buildBodyShards(db, tmpDir)
    const shardsDir = join(tmpDir, 'shards')
    const files = readdirSync(shardsDir)

    let foundFoundationKey = false
    for (const file of files) {
      const shard = await Bun.file(join(shardsDir, file)).json()
      if ('documentation/foundation/url' in shard) {
        foundFoundationKey = true
        break
      }
    }

    expect(foundFoundationKey).toBe(false)
  })

  test('returns shard metadata with letter and hash', async () => {
    const shardMeta = await buildBodyShards(db, tmpDir)
    expect(Array.isArray(shardMeta)).toBe(true)
    expect(shardMeta.length).toBeGreaterThanOrEqual(1)
    for (const meta of shardMeta) {
      expect(typeof meta.letter).toBe('string')
      expect(typeof meta.hash).toBe('string')
      expect(meta.hash).toMatch(/^[0-9a-f]{10}$/)
    }
  })
})

// ---------------------------------------------------------------------------
// generateSearchArtifacts
// ---------------------------------------------------------------------------

describe('generateSearchArtifacts', () => {
  test('creates content-hashed title-index, aliases, search-manifest.json, and shards/', async () => {
    await generateSearchArtifacts(db, tmpDir)
    // search-manifest.json is always unhashed
    expect(existsSync(join(tmpDir, 'search-manifest.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'shards'))).toBe(true)
    // title-index and aliases have content-hashed filenames
    const files = readdirSync(tmpDir)
    expect(files.some(f => /^title-index\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
    expect(files.some(f => /^aliases\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
  })

  test('returns correct counts', async () => {
    const result = await generateSearchArtifacts(db, tmpDir)
    expect(result.titleCount).toBe(2)
    expect(typeof result.aliasCount).toBe('number')
    expect(result.aliasCount).toBeGreaterThan(0)
    expect(typeof result.shardCount).toBe('number')
    expect(result.shardCount).toBeGreaterThanOrEqual(1)
  })

  test('hashed title-index contains valid v2 columnar structure', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    const titleFile = manifest.files['title-index']
    const data = await Bun.file(join(tmpDir, titleFile)).json()
    expect(data.v).toBe(2)
    expect(Array.isArray(data.frameworks)).toBe(true)
    expect(Array.isArray(data.keys)).toBe(true)
    expect(data.keys).toHaveLength(2)
  })

  test('hashed aliases.json contains the alias mapping object', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    const aliasFile = manifest.files.aliases
    const data = await Bun.file(join(tmpDir, aliasFile)).json()
    expect(typeof data).toBe('object')
    expect(data.coreanimation).toBe('quartzcore')
  })

  test('search-manifest.json contains expected v2 fields and file mappings', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.version).toBe(2)
    expect(typeof manifest.titleCount).toBe('number')
    expect(typeof manifest.aliasCount).toBe('number')
    expect(typeof manifest.shardCount).toBe('number')
    expect(typeof manifest.generatedAt).toBe('string')
    expect(typeof manifest.files).toBe('object')
    expect(manifest.files['title-index']).toMatch(/^title-index\.[0-9a-f]{10}\.json$/)
    expect(manifest.files.aliases).toMatch(/^aliases\.[0-9a-f]{10}\.json$/)
    // generatedAt should be a valid ISO 8601 date
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt)
  })

  test('manifest titleCount matches number of documents', async () => {
    const { titleCount } = await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.titleCount).toBe(titleCount)
    expect(manifest.titleCount).toBe(2)
  })

  test('manifest files contain shard entries', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    const shardKeys = Object.keys(manifest.files).filter(k => k.startsWith('shard-'))
    expect(shardKeys.length).toBeGreaterThanOrEqual(1)
    for (const key of shardKeys) {
      expect(manifest.files[key]).toMatch(/^shards\/[a-z_]\.[0-9a-f]{10}\.json$/)
    }
  })
})

// ---------------------------------------------------------------------------
// Edge case: empty database
// ---------------------------------------------------------------------------

describe('empty database', () => {
  let emptyDb
  let emptyDir

  beforeEach(() => {
    emptyDb = new DocsDatabase(':memory:')
    emptyDir = mkdtempSync(join(tmpdir(), 'apple-docs-empty-'))
  })

  afterEach(() => {
    emptyDb.close()
    rmSync(emptyDir, { recursive: true, force: true })
  })

  test('buildTitleIndex on empty db returns empty columnar arrays', () => {
    const result = buildTitleIndex(emptyDb)
    expect(result.v).toBe(2)
    expect(result.frameworks).toEqual([])
    expect(result.keys).toEqual([])
    expect(result.titles).toEqual([])
  })

  test('buildAliasMap on empty synonyms still returns seeded synonyms', () => {
    // DocsDatabase always seeds framework_synonyms on init
    const aliasMap = buildAliasMap(emptyDb)
    expect(typeof aliasMap).toBe('object')
  })

  test('buildBodyShards on empty db returns empty array and does not crash', async () => {
    const shardMeta = await buildBodyShards(emptyDb, emptyDir)
    expect(shardMeta).toEqual([])
  })

  test('generateSearchArtifacts on empty db produces valid artifacts without crashing', async () => {
    const result = await generateSearchArtifacts(emptyDb, emptyDir)
    expect(result.titleCount).toBe(0)
    expect(result.shardCount).toBe(0)
    expect(existsSync(join(emptyDir, 'search-manifest.json'))).toBe(true)
    // Content-hashed files should still be present
    const files = readdirSync(emptyDir)
    expect(files.some(f => /^title-index\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
    expect(files.some(f => /^aliases\.[0-9a-f]{10}\.json$/.test(f))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// writeSearchManifest (unit)
// ---------------------------------------------------------------------------

describe('writeSearchManifest', () => {
  test('writes search-manifest.json with expected v2 fields', async () => {
    const files = { 'title-index': 'title-index.abc1234567.json', 'aliases': 'aliases.def7654321.json' }
    await writeSearchManifest(tmpDir, { titleCount: 10, aliasCount: 5, shardCount: 3, files })
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.version).toBe(2)
    expect(manifest.titleCount).toBe(10)
    expect(manifest.aliasCount).toBe(5)
    expect(manifest.shardCount).toBe(3)
    expect(manifest.files).toEqual(files)
    expect(typeof manifest.generatedAt).toBe('string')
  })

  test('generatedAt is a recent timestamp', async () => {
    const before = Date.now()
    await writeSearchManifest(tmpDir, { titleCount: 0, aliasCount: 0, shardCount: 0, files: {} })
    const after = Date.now()
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    const ts = new Date(manifest.generatedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
