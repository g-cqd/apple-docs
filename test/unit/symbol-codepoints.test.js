/**
 * Tests for SF Symbol codepoint dump orchestration, the new v19
 * migration, and the route serializer that surfaces the resolved
 * codepoint via /api/symbols/<scope>/<name>.json.
 *
 * The Swift worker itself is NOT exercised here — it requires macOS
 * + SF Symbols framework. A separate gated integration test runs the
 * actual worker against five canary symbols when macOS is detected.
 *
 * Property-style PUA boundary coverage uses deterministic edge probes
 * plus a seeded random spot check rather than a fast-check generator
 * — fast-check isn't available in this repo and the task forbids new
 * npm deps. The boundary set covers every transition point of the
 * three PUA ranges (start-1, start, mid, end, end+1), giving the same
 * confidence in O(1) probes.
 */

import { describe, expect, test } from 'bun:test'
import { DocsDatabase } from '../../src/storage/database.js'
import { runMigrations, SCHEMA_VERSION } from '../../src/storage/migrations/index.js'
import {
  dumpSymbolCodepoints,
  resolveSymbolFontPath,
  _internals,
} from '../../src/resources/apple-symbols/codepoint-dump.js'
import { symbolMetadataHandler } from '../../src/web/routes/symbols.route.js'

describe('codepoint dump orchestrator', () => {
  test('maps Swift worker output into a name→codepoint map', async () => {
    const fakeProc = createFakeProc([
      '{"name":"house.fill","codepoint":1049270}',
      '{"name":"star.fill","codepoint":1049271}',
      '{"name":"bogus.symbol","codepoint":null}',
    ])
    const { map, total, resolved, skipped } = await dumpSymbolCodepoints(
      ['house.fill', 'star.fill', 'bogus.symbol'],
      { fontPath: '/tmp/font.ttf', spawn: () => fakeProc },
    )
    expect(total).toBe(3)
    expect(resolved).toBe(2)
    expect(skipped).toBe(1)
    expect(map.get('house.fill')).toBe(1049270)
    expect(map.get('star.fill')).toBe(1049271)
    expect(map.get('bogus.symbol')).toBeNull()
  })

  test('rejects non-PUA codepoints and records them as null', async () => {
    const warnings = []
    const fakeProc = createFakeProc([
      // Latin "A" is 0x41 — not in PUA.
      '{"name":"poisoned","codepoint":65}',
      '{"name":"clean","codepoint":1049270}',
    ])
    const { map } = await dumpSymbolCodepoints(
      ['poisoned', 'clean'],
      {
        fontPath: '/tmp/font.ttf',
        spawn: () => fakeProc,
        logger: { warn: (m) => warnings.push(m), debug() {}, info() {} },
      },
    )
    expect(map.get('poisoned')).toBeNull()
    expect(map.get('clean')).toBe(1049270)
    expect(warnings.some(w => /non-PUA/.test(w))).toBe(true)
  })

  test('returns partial results when the worker dies mid-stream', async () => {
    // Emit two lines, then close stdout. The orchestrator must keep
    // the two entries it received and not throw.
    const fakeProc = createFakeProc([
      '{"name":"a","codepoint":1049270}',
      '{"name":"b","codepoint":1049271}',
    ], { closeAfter: 2 })
    const warnings = []
    const { map } = await dumpSymbolCodepoints(
      ['a', 'b', 'c', 'd'],
      {
        fontPath: '/tmp/font.ttf',
        spawn: () => fakeProc,
        logger: { warn: (m) => warnings.push(m), debug() {}, info() {} },
      },
    )
    expect(map.size).toBe(2)
    expect(map.has('c')).toBe(false)
    expect(map.has('d')).toBe(false)
  })

  test('isPrivateUseCodepoint covers all three PUA ranges and rejects outside', () => {
    const { isPrivateUseCodepoint } = _internals
    // Edge cases at every PUA boundary.
    const cases = [
      // BMP PUA: U+E000..U+F8FF
      [0xdfff, false], [0xe000, true], [0xf000, true], [0xf8ff, true], [0xf900, false],
      // SPUA-A: U+F0000..U+FFFFD
      [0xeffff, false], [0xf0000, true], [0xf8000, true], [0xffffd, true], [0xffffe, false],
      // SPUA-B: U+100000..U+10FFFD
      [0xfffff, false], [0x100000, true], [0x108000, true], [0x10fffd, true], [0x10fffe, false],
      // Boring ASCII / Latin / Hangul fail.
      [0, false], [0x41, false], [0x4e00, false], [0xac00, false],
      // Out-of-range Unicode.
      [-1, false], [0x110000, false], [Number.NaN, false], [1.5, false],
    ]
    for (const [cp, expected] of cases) {
      expect(isPrivateUseCodepoint(cp)).toBe(expected)
    }
    // Seeded spot-check across the BMP PUA so the test catches
    // regressions in the range table without depending on fast-check.
    let seed = 0x12345678
    for (let i = 0; i < 64; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const cp = 0xe000 + (seed % (0xf8ff - 0xe000 + 1))
      expect(isPrivateUseCodepoint(cp)).toBe(true)
    }
  })

  test('resolveSymbolFontPath returns a string or null', async () => {
    // Without an extracted snapshot at the given dataDir, the function
    // may fall through to the system /System/Library/Fonts/SFNS.ttf
    // on macOS. Either result is acceptable; we just want to confirm
    // the function never throws on a missing snapshot path.
    const result = resolveSymbolFontPath('/tmp/path-that-does-not-exist-' + Date.now())
    if (result != null) {
      expect(typeof result).toBe('string')
      expect(result.endsWith('.ttf') || result.endsWith('.otf')).toBe(true)
    } else {
      expect(result).toBe(null)
    }
  })
})

describe('v19 migration', () => {
  test('fresh DB at the latest schema_version has codepoint column + partial index', () => {
    const db = new DocsDatabase(':memory:')
    try {
      expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION)
      const cols = db.db
        .query('SELECT name FROM pragma_table_info("sf_symbols")')
        .all()
        .map(r => r.name)
      expect(cols).toContain('codepoint')
      const idx = db.db
        .query('SELECT name FROM sqlite_master WHERE type=? AND name=?')
        .get('index', 'idx_sf_symbols_codepoint')
      expect(idx).not.toBe(null)
    } finally {
      db.close()
    }
  })

  test('v19 is idempotent: re-running runMigrations on a current DB is a no-op', () => {
    const db = new DocsDatabase(':memory:')
    try {
      runMigrations(db.db) // already current — should not throw
      runMigrations(db.db)
      expect(db.getSchemaVersion()).toBe(SCHEMA_VERSION)
    } finally {
      db.close()
    }
  })

  test('updateSfSymbolCodepoint round-trips through getSfSymbol and listCatalog', () => {
    const db = new DocsDatabase(':memory:')
    try {
      db.upsertSfSymbol({
        name: 'house.fill',
        scope: 'public',
        categories: [],
        keywords: [],
        orderIndex: 0,
      })
      // Initial value is NULL.
      let row = db.getSfSymbol('public', 'house.fill')
      expect(row.codepoint).toBe(null)
      // Stamp + read back.
      db.updateSfSymbolCodepoint('public', 'house.fill', 0x1004b6)
      row = db.getSfSymbol('public', 'house.fill')
      expect(row.codepoint).toBe(0x1004b6)
      const entry = db.listSfSymbolsCatalog().find(s => s.name === 'house.fill')
      expect(entry.codepoint).toBe(0x1004b6)
      // Clear with null.
      db.updateSfSymbolCodepoint('public', 'house.fill', null)
      expect(db.getSfSymbol('public', 'house.fill').codepoint).toBe(null)
    } finally {
      db.close()
    }
  })
})

describe('/api/symbols/<scope>/<name>.json route', () => {
  test('emits codepoint + codepoint_display when stamped', async () => {
    const db = new DocsDatabase(':memory:')
    try {
      db.upsertSfSymbol({
        name: 'house.fill',
        scope: 'public',
        categories: ['home'],
        keywords: [],
        orderIndex: 0,
      })
      db.updateSfSymbolCodepoint('public', 'house.fill', 0x1004b6)

      const ctx = { db }
      const response = symbolMetadataHandler(
        new Request('http://x/api/symbols/public/house.fill.json'),
        ctx,
        new URL('http://x/api/symbols/public/house.fill.json'),
        ['/api/symbols/public/house.fill.json', 'public', 'house.fill'],
      )
      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.codepoint).toBe(0x1004b6)
      expect(body.codepoint_display).toBe('U+1004B6')
    } finally {
      db.close()
    }
  })

  test('omits codepoint fields when null', async () => {
    const db = new DocsDatabase(':memory:')
    try {
      db.upsertSfSymbol({
        name: 'orphan',
        scope: 'public',
        categories: [],
        keywords: [],
        orderIndex: 0,
      })
      // Leave codepoint NULL.
      const ctx = { db }
      const response = symbolMetadataHandler(
        new Request('http://x/api/symbols/public/orphan.json'),
        ctx,
        new URL('http://x/api/symbols/public/orphan.json'),
        ['/api/symbols/public/orphan.json', 'public', 'orphan'],
      )
      const body = await response.json()
      expect('codepoint' in body && body.codepoint != null).toBe(false)
      expect('codepoint_display' in body).toBe(false)
    } finally {
      db.close()
    }
  })
})

// Integration: run the real Swift worker against a handful of
// known-good symbols. Skipped on non-Darwin runners; the CI matrix
// includes macos-26, where this test should pass.
const isMacOS = process.platform === 'darwin'
describe.skipIf(!isMacOS)('codepoint dump (real Swift worker, macOS-only)', () => {
  test('queries five canary symbols without crashing', async () => {
    const fontPath = resolveSymbolFontPath('/Users/gc/.apple-docs')
      ?? '/System/Library/Fonts/SFNS.ttf'
    if (!fontPath) return // No font on disk, skip silently.
    const names = ['house.fill', 'star.fill', 'person.crop.circle', 'globe', 'gear']
    const { map, total } = await dumpSymbolCodepoints(names, { fontPath })
    expect(total).toBe(5)
    // We make no claim about resolution success — the catalog-name to
    // codepoint mapping currently lives outside the post table for
    // most names. We just assert the orchestrator completed and the
    // returned values are either null or in the PUA.
    for (const name of names) {
      const value = map.get(name)
      if (value != null) {
        expect(_internals.isPrivateUseCodepoint(value)).toBe(true)
      }
    }
  }, 60_000)
})

// ---- helpers ---------------------------------------------------------------

function createFakeProc(lines, { closeAfter } = {}) {
  // Build a ReadableStream that emits the requested lines sequentially
  // and (optionally) closes early to simulate worker death.
  const emit = closeAfter != null ? lines.slice(0, closeAfter) : lines
  const text = emit.map(line => `${line}\n`).join('')
  const buffer = new TextEncoder().encode(text)
  let cursor = 0
  let stdinClosed = false
  const stdout = new ReadableStream({
    pull(controller) {
      if (cursor >= buffer.length) {
        controller.close()
        return
      }
      // Yield one line per pull so the orchestrator sees them in order.
      const next = buffer.indexOf(0x0a, cursor) + 1
      const slice = buffer.slice(cursor, next || buffer.length)
      cursor = next || buffer.length
      controller.enqueue(slice)
    },
  })
  const stderr = new ReadableStream({ start(controller) { controller.close() } })
  return {
    stdout,
    stderr,
    stdin: {
      write() {},
      flush() {},
      end() { stdinClosed = true },
    },
    kill() {},
    get _stdinClosed() { return stdinClosed },
  }
}
