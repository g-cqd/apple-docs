import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'

let db

beforeEach(() => {
  db = new DocsDatabase(':memory:')
})

afterEach(() => {
  db.close()
})

function insert(cacheKey, opts = {}) {
  db.upsertSfSymbolRender({
    cacheKey,
    name: opts.name ?? cacheKey,
    scope: 'public',
    format: 'svg',
    mode: 'live',
    weight: 'regular',
    symbolScale: 'medium',
    pointSize: 64,
    color: '#000000',
    filePath: opts.filePath ?? `/tmp/${cacheKey}.svg`,
    mimeType: 'image/svg+xml; charset=utf-8',
    sha256: opts.sha256 ?? 'abc',
    size: opts.size ?? 1024,
  })
  // Override updated_at so we can simulate aged rows.
  if (opts.updatedAtIso) {
    db.db.run(
      'UPDATE sf_symbol_renders SET updated_at = ? WHERE cache_key = ?',
      [opts.updatedAtIso, cacheKey],
    )
  }
}

describe('render-cache prune (A1)', () => {
  test('renderCacheStats reports count + bytes', () => {
    insert('k1', { size: 1000 })
    insert('k2', { size: 2000 })
    const stats = db.sfSymbolRenderCacheStats()
    expect(stats.count).toBe(2)
    expect(stats.bytes).toBe(3000)
  })

  test('pruneRendersOlderThan removes rows below cutoff', () => {
    insert('old', { updatedAtIso: '2024-01-01T00:00:00.000Z' })
    insert('newer', { updatedAtIso: '2026-01-01T00:00:00.000Z' })
    const result = db.pruneSfSymbolRendersOlderThan('2025-01-01T00:00:00.000Z')
    expect(result.removed).toBe(1)
    expect(result.paths).toEqual(['/tmp/old.svg'])
    expect(db.sfSymbolRenderCacheStats().count).toBe(1)
    expect(db.getSfSymbolRender('newer')).not.toBeNull()
  })

  test('pruneRendersToBytesQuota is a no-op when under quota', () => {
    insert('a', { size: 1000 })
    insert('b', { size: 2000 })
    const result = db.pruneSfSymbolRendersToBytesQuota(10_000)
    expect(result.removed).toBe(0)
    expect(result.paths).toEqual([])
    expect(db.sfSymbolRenderCacheStats().count).toBe(2)
  })

  test('pruneRendersToBytesQuota removes oldest first until under quota', () => {
    insert('oldest', { size: 5000, updatedAtIso: '2024-01-01T00:00:00.000Z' })
    insert('middle', { size: 5000, updatedAtIso: '2025-01-01T00:00:00.000Z' })
    insert('newest', { size: 5000, updatedAtIso: '2026-01-01T00:00:00.000Z' })
    // Total 15 KB; quota 7 KB → drop oldest + middle.
    const result = db.pruneSfSymbolRendersToBytesQuota(7000)
    expect(result.removed).toBe(2)
    expect(result.paths).toContain('/tmp/oldest.svg')
    expect(result.paths).toContain('/tmp/middle.svg')
    expect(db.getSfSymbolRender('newest')).not.toBeNull()
    expect(db.getSfSymbolRender('oldest')).toBeNull()
  })

  test('pruneRendersOlderThan with no matches is a no-op', () => {
    insert('x', { updatedAtIso: '2026-01-01T00:00:00.000Z' })
    const result = db.pruneSfSymbolRendersOlderThan('2024-01-01T00:00:00.000Z')
    expect(result.removed).toBe(0)
    expect(db.sfSymbolRenderCacheStats().count).toBe(1)
  })
})
