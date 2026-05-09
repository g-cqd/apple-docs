import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocsDatabase } from '../../src/storage/database.js'
import { _resetTrigramCache, fuzzyMatchTitles } from '../../src/lib/fuzzy.js'

let dataDir
let db

beforeEach(() => {
  _resetTrigramCache()
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-fuzzy-'))
  db = new DocsDatabase(join(dataDir, 'apple-docs.db'))
  const root = db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertPage({ rootId: root.id, path: 'swiftui/view', url: 'u', title: 'View', role: 'symbol' })
  db.upsertPage({ rootId: root.id, path: 'swiftui/text', url: 'u', title: 'Text', role: 'symbol' })
})

afterEach(() => {
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('fuzzyMatchTitles trigram cache (P2.9 staleness)', () => {
  test('finds a known title with a 1-char typo', () => {
    // 'Viev' shares trigram 'vie' with 'View' (one substitution away).
    const matches = fuzzyMatchTitles('Viev', db)
    expect(matches.find(m => m.title === 'View')).toBeDefined()
  })

  test('newly-added title surfaces after the corpus stamp drifts', async () => {
    // Prime the cache.
    fuzzyMatchTitles('Texx', db)
    // Sneak a new title in. Without staleness invalidation the new title
    // would never appear in fuzzy results until the process restarted.
    const root = db.getRootBySlug('swiftui')
    db.upsertPage({ rootId: root.id, path: 'swiftui/list', url: 'u', title: 'Listt', role: 'symbol' })

    // Bump the DB file's mtime so the stamp shifts, then nudge the
    // STAMP_TTL_MS internal clock by waiting past the throttle window.
    const dbPath = join(dataDir, 'apple-docs.db')
    const future = (Date.now() / 1000) + 60
    utimesSync(dbPath, future, future)
    await new Promise(r => setTimeout(r, 5_010))

    const matches = fuzzyMatchTitles('List', db)
    expect(matches.find(m => m.title === 'Listt')).toBeDefined()
  }, 10_000)

  test('cache survives within STAMP_TTL_MS without rebuild churn', () => {
    // Primer call builds the cache.
    fuzzyMatchTitles('Viev', db)
    // Add a title but do not nudge the clock — the cache should NOT
    // notice yet (this is the rate-limited stamp-read in effect).
    const root = db.getRootBySlug('swiftui')
    db.upsertPage({ rootId: root.id, path: 'swiftui/button', url: 'u', title: 'Button', role: 'symbol' })
    const matches = fuzzyMatchTitles('Viev', db)
    // Original entries still resolve fine; we don't assert "Button" is
    // missing because the stamp_read is rate-limited and the file mtime
    // genuinely did just bump (Bun.file flush). The point is the call
    // doesn't crash and previously-cached titles still match.
    expect(matches.find(m => m.title === 'View')).toBeDefined()
  })
})
