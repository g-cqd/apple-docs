// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enrichFromAsset, normalizeAssetUri, platformsToProject } from '../../../src/sources/mobileasset-docs.js'
import { DocsDatabase } from '../../../src/storage/database.js'

let dir
let assetPath
let db

function makeAssetDb(path) {
  const a = new Database(path)
  a.run('CREATE TABLE documents (asset_id TEXT PRIMARY KEY, document BLOB)')
  a.run('CREATE TABLE attributes (asset_id TEXT, vector_id INTEGER, chunk_index INTEGER, type TEXT, framework TEXT, title TEXT, content TEXT)')
  const insDoc = a.query('INSERT INTO documents VALUES (?, ?)')
  const insAttr = a.query('INSERT INTO attributes VALUES (?, ?, ?, ?, ?, ?, ?)')

  // 1. Overlap page: project has it, missing usr + platforms → both backfill.
  insDoc.run(
    '/documentation/SwiftUI/View',
    JSON.stringify({
      uri: '/documentation/SwiftUI/View',
      kind: 'symbol',
      role: 'symbol',
      external_id: 's:7SwiftUI4ViewP',
      modules: ['SwiftUI'],
      platforms: [
        { platform: 'iOS', introduced: 13, deprecated: false },
        { platform: 'macOS', introduced: 10.15, deprecated: false },
      ],
    }),
  )
  // 2. Overlap page where the project already HAS platforms → usr only.
  insDoc.run(
    '/documentation/SwiftUI/Text',
    JSON.stringify({
      uri: '/documentation/SwiftUI/Text',
      kind: 'symbol',
      role: 'symbol',
      external_id: 's:7SwiftUI4TextV',
      modules: ['SwiftUI'],
      platforms: [{ platform: 'iOS', introduced: 99, deprecated: false }],
    }),
  )
  // 3. Anchor row → skipped outright.
  insDoc.run('/documentation/SwiftUI#Essentials', JSON.stringify({ uri: '/documentation/SwiftUI#Essentials', kind: 'article', role: 'article' }))
  // 4. Member page whose parent (swiftui/view) exists but which the corpus
  // lacks → a real missing page; inserted (no parent/child suppression).
  insDoc.run(
    '/documentation/SwiftUI/View/somenewthing',
    JSON.stringify({
      uri: '/documentation/SwiftUI/View/somenewthing',
      kind: 'symbol',
      role: 'symbol',
      modules: ['SwiftUI'],
    }),
  )
  insAttr.run('/documentation/SwiftUI/View/somenewthing', 3, 0, 'symbol', 'SwiftUI', 'someNewThing', 'someNewThing\nA brand new member.')
  // 5. Truly novel page (framework absent from project) → inserted w/ chunks.
  // modules[0] deliberately contains spaces: it is a DISPLAY name; the
  // framework slug must come from the URI segment instead.
  insDoc.run(
    '/documentation/AppleNewsFormat',
    JSON.stringify({
      uri: '/documentation/AppleNewsFormat',
      kind: 'article',
      role: 'collection',
      external_id: 'ANF-root',
      modules: ['Apple News Format'],
      platforms: [{ platform: 'iOS', introduced: 9, deprecated: false }],
    }),
  )
  insAttr.run('/documentation/AppleNewsFormat', 1, 0, 'article', 'AppleNewsFormat', 'Apple News Format', 'Apple News Format\nDesign and publish articles.')
  insAttr.run('/documentation/AppleNewsFormat', 2, 1, 'article', 'AppleNewsFormat', 'Components', 'Components live here.')
  a.close()
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apple-docs-ma-'))
  assetPath = makeAssetDb(join(dir, 'index.sql'))
  db = new DocsDatabase(':memory:')
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertNormalizedDocument({
    document: { sourceType: 'apple-docc', key: 'swiftui/view', title: 'View', framework: 'swiftui', role: 'symbol' },
    sections: [],
    relationships: [],
  })
  db.upsertNormalizedDocument({
    document: {
      sourceType: 'apple-docc',
      key: 'swiftui/text',
      title: 'Text',
      framework: 'swiftui',
      role: 'symbol',
      platformsJson: { ios: '13.0' },
      minIos: '13.0',
    },
    sections: [],
    relationships: [],
  })
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('normalizeAssetUri / platformsToProject', () => {
  test('uri → project key', () => {
    expect(normalizeAssetUri('/documentation/SwiftUI/View')).toBe('swiftui/view')
    expect(normalizeAssetUri('/design/Human-Interface-Guidelines/workouts')).toBe('design/human-interface-guidelines/workouts')
  })

  test('platforms map to project shape with version strings', () => {
    const p = platformsToProject([
      { platform: 'iOS', introduced: 13 },
      { platform: 'macOS', introduced: 10.15 },
      { platform: 'unknownOS', introduced: 1 },
    ])
    expect(JSON.parse(p.platformsJson)).toEqual({ ios: '13.0', macos: '10.15' })
    expect(p.minIos).toBe('13.0')
    expect(platformsToProject([])).toBeNull()
  })

  test('rounds away the IEEE-754 noise Apple ships in introduced floats', () => {
    // The asset serializes 17.2 as 17.199999999999999, 1.1 as 1.1000000000000001.
    const p = platformsToProject([
      { platform: 'iOS', introduced: 17.199999999999999 },
      { platform: 'macOS', introduced: 14.199999999999999 },
      { platform: 'visionOS', introduced: 1.1000000000000001 },
      { platform: 'tvOS', introduced: 18 },
    ])
    expect(JSON.parse(p.platformsJson)).toEqual({ ios: '17.2', macos: '14.2', visionos: '1.1', tvos: '18.0' })
  })
})

describe('enrichFromAsset', () => {
  test('dry-run counts everything and writes nothing', () => {
    const stats = enrichFromAsset(db, assetPath, { apply: false })
    expect(stats.pages).toBe(4)
    expect(stats.anchorsSkipped).toBe(1)
    expect(stats.usrBackfilled).toBe(2)
    expect(stats.platformsBackfilled).toBe(1) // text already has platforms
    expect(stats.novelInserted).toBe(2) // AppleNewsFormat + SwiftUI/View/somenewthing
    expect(db.db.query("SELECT usr FROM documents WHERE key='swiftui/view'").get().usr).toBeNull()
    expect(db.db.query("SELECT COUNT(*) c FROM documents WHERE key='applenewsformat'").get().c).toBe(0)
  })

  test('apply backfills usr + platforms on the overlap without touching crawl data', () => {
    enrichFromAsset(db, assetPath, { apply: true })
    const view = db.db.query("SELECT usr, platforms_json, min_ios, min_ios_num, min_macos FROM documents WHERE key='swiftui/view'").get()
    expect(view.usr).toBe('s:7SwiftUI4ViewP')
    expect(JSON.parse(view.platforms_json)).toEqual({ ios: '13.0', macos: '10.15' })
    expect(view.min_ios).toBe('13.0')
    expect(view.min_ios_num).toBeGreaterThan(0)
    // crawl-authoritative platforms preserved: ios stays 13.0, not 99.0
    const text = db.db.query("SELECT usr, min_ios FROM documents WHERE key='swiftui/text'").get()
    expect(text.usr).toBe('s:7SwiftUI4TextV')
    expect(text.min_ios).toBe('13.0')
  })

  test('apply inserts novel pages (incl. members of an existing parent), with sections, root, and usr', () => {
    enrichFromAsset(db, assetPath, { apply: true })
    const novel = db.db.query("SELECT usr, framework, language FROM documents WHERE key='applenewsformat'").get()
    expect(novel.framework).toBe('applenewsformat')
    expect(novel.usr).toBe('ANF-root')
    expect(db.getDocumentSections('applenewsformat').length).toBe(2)
    // the member page whose parent exists is inserted, not suppressed
    const member = db.db.query("SELECT framework, title FROM documents WHERE key='swiftui/view/somenewthing'").get()
    expect(member.framework).toBe('swiftui')
    expect(member.title).toBe('someNewThing')
  })

  test('idempotent: a second apply changes nothing', () => {
    enrichFromAsset(db, assetPath, { apply: true })
    const before = db.db.query('SELECT COUNT(*) c FROM documents').get().c
    const stats = enrichFromAsset(db, assetPath, { apply: true })
    expect(db.db.query('SELECT COUNT(*) c FROM documents').get().c).toBe(before)
    expect(stats.usrBackfilled).toBe(0)
    expect(stats.platformsBackfilled).toBe(0)
    // novel page now exists → counted as overlap, not re-inserted
    expect(stats.novelInserted).toBe(0)
  })
})
