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
  test('returns object with frameworks array and entries array', () => {
    const result = buildTitleIndex(db)
    expect(result).toHaveProperty('frameworks')
    expect(result).toHaveProperty('entries')
    expect(Array.isArray(result.frameworks)).toBe(true)
    expect(Array.isArray(result.entries)).toBe(true)
  })

  test('frameworks array contains all distinct frameworks sorted', () => {
    const { frameworks } = buildTitleIndex(db)
    expect(frameworks).toContain('foundation')
    expect(frameworks).toContain('swiftui')
    // Should be sorted
    const sorted = [...frameworks].sort()
    expect(frameworks).toEqual(sorted)
  })

  test('entries contain one entry per document', () => {
    const { entries } = buildTitleIndex(db)
    expect(entries).toHaveLength(2)
  })

  test('each entry is a compact array with key, title, abstract snippet, framework index, kind, role_heading', () => {
    const { frameworks, entries } = buildTitleIndex(db)
    const viewEntry = entries.find(e => e[0] === 'documentation/swiftui/view')
    expect(viewEntry).toBeDefined()
    const [key, title, abstract, fwIdx, kind, roleHeading] = viewEntry
    expect(key).toBe('documentation/swiftui/view')
    expect(title).toBe('View')
    expect(typeof abstract).toBe('string')
    expect(abstract).toBe('A type that represents part of your app UI') // 42 chars, under 80
    expect(fwIdx).toBe(frameworks.indexOf('swiftui'))
    expect(kind).toBe('symbol')
    expect(roleHeading).toBe('') // not seeded
  })

  test('abstract snippet is truncated to 80 characters', () => {
    const now = new Date().toISOString()
    const longAbstract = 'A'.repeat(200)
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/corefoundation/cfstring', 'CFString', 'symbol', 'corefoundation', ?, ?, ?)`,
      [longAbstract, now, now],
    )

    const { entries } = buildTitleIndex(db)
    const entry = entries.find(e => e[0] === 'documentation/corefoundation/cfstring')
    expect(entry[2]).toHaveLength(80)
  })

  test('document with no framework gets framework index of -1', () => {
    const now = new Date().toISOString()
    db.db.run(
      `INSERT INTO documents (source_type, key, title, kind, framework, abstract_text, created_at, updated_at)
       VALUES ('apple-docc', 'documentation/noframework/doc', 'NoFW', 'article', NULL, 'No framework', ?, ?)`,
      [now, now],
    )

    const { entries } = buildTitleIndex(db)
    const entry = entries.find(e => e[0] === 'documentation/noframework/doc')
    expect(entry[3]).toBe(-1)
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

  test('creates shard files in output directory', async () => {
    const count = await buildBodyShards(db, tmpDir)
    const shardsDir = join(tmpDir, 'shards')
    const files = readdirSync(shardsDir)
    expect(files.length).toBeGreaterThan(0)
    expect(count).toBe(files.length)
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

  test('returns the number of shard files written', async () => {
    const count = await buildBodyShards(db, tmpDir)
    expect(typeof count).toBe('number')
    expect(count).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// generateSearchArtifacts
// ---------------------------------------------------------------------------

describe('generateSearchArtifacts', () => {
  test('creates title-index.json, aliases.json, search-manifest.json, and shards/ directory', async () => {
    await generateSearchArtifacts(db, tmpDir)
    expect(existsSync(join(tmpDir, 'title-index.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'aliases.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'search-manifest.json'))).toBe(true)
    expect(existsSync(join(tmpDir, 'shards'))).toBe(true)
  })

  test('returns correct counts', async () => {
    const result = await generateSearchArtifacts(db, tmpDir)
    expect(result.titleCount).toBe(2)
    expect(typeof result.aliasCount).toBe('number')
    expect(result.aliasCount).toBeGreaterThan(0)
    expect(typeof result.shardCount).toBe('number')
    expect(result.shardCount).toBeGreaterThanOrEqual(1)
  })

  test('title-index.json contains valid index structure', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const data = await Bun.file(join(tmpDir, 'title-index.json')).json()
    expect(Array.isArray(data.frameworks)).toBe(true)
    expect(Array.isArray(data.entries)).toBe(true)
    expect(data.entries).toHaveLength(2)
  })

  test('aliases.json contains the alias mapping object', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const data = await Bun.file(join(tmpDir, 'aliases.json')).json()
    expect(typeof data).toBe('object')
    expect(data.coreanimation).toBe('quartzcore')
  })

  test('search-manifest.json contains expected fields', async () => {
    await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.version).toBe(1)
    expect(typeof manifest.titleCount).toBe('number')
    expect(typeof manifest.aliasCount).toBe('number')
    expect(typeof manifest.shardCount).toBe('number')
    expect(typeof manifest.generatedAt).toBe('string')
    // generatedAt should be a valid ISO 8601 date
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt)
  })

  test('manifest titleCount matches number of documents', async () => {
    const { titleCount } = await generateSearchArtifacts(db, tmpDir)
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.titleCount).toBe(titleCount)
    expect(manifest.titleCount).toBe(2)
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

  test('buildTitleIndex on empty db returns empty entries', () => {
    const { frameworks, entries } = buildTitleIndex(emptyDb)
    expect(frameworks).toEqual([])
    expect(entries).toEqual([])
  })

  test('buildAliasMap on empty synonyms still returns seeded synonyms', () => {
    // DocsDatabase always seeds framework_synonyms on init
    const aliasMap = buildAliasMap(emptyDb)
    expect(typeof aliasMap).toBe('object')
  })

  test('buildBodyShards on empty db returns 0 shards and does not crash', async () => {
    const count = await buildBodyShards(emptyDb, emptyDir)
    expect(count).toBe(0)
  })

  test('generateSearchArtifacts on empty db produces valid artifacts without crashing', async () => {
    const result = await generateSearchArtifacts(emptyDb, emptyDir)
    expect(result.titleCount).toBe(0)
    expect(result.shardCount).toBe(0)
    expect(existsSync(join(emptyDir, 'title-index.json'))).toBe(true)
    expect(existsSync(join(emptyDir, 'aliases.json'))).toBe(true)
    expect(existsSync(join(emptyDir, 'search-manifest.json'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// writeSearchManifest (unit)
// ---------------------------------------------------------------------------

describe('writeSearchManifest', () => {
  test('writes search-manifest.json with expected fields', async () => {
    await writeSearchManifest(tmpDir, { titleCount: 10, aliasCount: 5, shardCount: 3 })
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    expect(manifest.version).toBe(1)
    expect(manifest.titleCount).toBe(10)
    expect(manifest.aliasCount).toBe(5)
    expect(manifest.shardCount).toBe(3)
    expect(typeof manifest.generatedAt).toBe('string')
  })

  test('generatedAt is a recent timestamp', async () => {
    const before = Date.now()
    await writeSearchManifest(tmpDir, { titleCount: 0, aliasCount: 0, shardCount: 0 })
    const after = Date.now()
    const manifest = await Bun.file(join(tmpDir, 'search-manifest.json')).json()
    const ts = new Date(manifest.generatedAt).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})
