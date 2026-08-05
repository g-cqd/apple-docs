import { describe, expect, test } from 'bun:test'
import { stampSfSymbolCodepoints } from '../../../src/resources/apple-symbols/codepoint-stamp.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const noopLogger = { info() {}, warn() {}, error() {}, debug() {} }

describe('stampSfSymbolCodepoints skip gate', () => {
  test('skips entirely (no provisioning, no font dump) when every public symbol is stamped', async () => {
    const db = new DocsDatabase(':memory:')
    db.db.run(
      "INSERT INTO sf_symbols (name, scope, codepoint, updated_at) VALUES ('star', 'public', 100000, datetime('now'))",
    )
    db.db.run(
      "INSERT INTO sf_symbols (name, scope, codepoint, updated_at) VALUES ('heart', 'public', 100001, datetime('now'))",
    )

    const result = await stampSfSymbolCodepoints({}, { db, dataDir: '/tmp/apple-docs-stamp-test', logger: noopLogger })

    expect(result.skipped).toBe(true)
    expect(result.total).toBe(2)
    db.close()
  })

  test('does not skip while any public symbol lacks a codepoint', async () => {
    const db = new DocsDatabase(':memory:')
    db.db.run(
      "INSERT INTO sf_symbols (name, scope, codepoint, updated_at) VALUES ('star', 'public', NULL, datetime('now'))",
    )

    // With a missing codepoint the gate opens; the run then fails to
    // resolve a font (no SF Symbols.app in the test env) and reports the
    // non-skipped empty result — proving the gate did not short-circuit.
    const result = await stampSfSymbolCodepoints(
      { forceRefresh: false, appPath: '/nonexistent' },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger: noopLogger },
    )

    expect(result.skipped).toBeUndefined()
    db.close()
  })
})

describe('stampSfSymbolCodepoints attempted-version gate', () => {
  test('unresolvable-but-answered names are marked attempted and settle the gate', async () => {
    const db = new DocsDatabase(':memory:')
    db.upsertSfSymbol({ name: 'star', scope: 'public', categories: [], keywords: [], orderIndex: 0 })
    db.upsertSfSymbol({ name: 'future.symbol', scope: 'public', categories: [], keywords: [], orderIndex: 1 })
    const infos = []
    const logger = { info: m => infos.push(m), warn() {}, error() {}, debug() {} }

    // The worker answers both names; 'future.symbol' resolves to null
    // (app/OS catalog version skew).
    const result = await stampSfSymbolCodepoints(
      {
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        spawn: () => createEchoProc(name => (name === 'star' ? 0xe100 : null)),
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger },
    )
    expect(result.stamped).toBe(1)
    expect(result.missing).toBe(1)
    expect(result.unanswered).toBe(0)
    expect(infos.some(m => /not resolvable by SF Symbols\.app/.test(m))).toBe(true)
    const row = db.db.query(
      "SELECT codepoint, codepoint_attempted_version FROM sf_symbols WHERE name = 'future.symbol'",
    ).get()
    expect(row.codepoint).toBeNull()
    expect(row.codepoint_attempted_version).toBeTruthy()

    // Steady state: the settled NULL row no longer reopens the gate.
    let spawned = 0
    const second = await stampSfSymbolCodepoints(
      { spawn: () => { spawned++; return createEchoProc(() => 0xe000) } },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger },
    )
    expect(second.skipped).toBe(true)
    expect(spawned).toBe(0)

    // forceRefresh re-attempts settled rows.
    const third = await stampSfSymbolCodepoints(
      {
        forceRefresh: true,
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        spawn: () => createEchoProc(() => 0xe200),
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger },
    )
    expect(third.stamped).toBe(2)
    expect(db.getSfSymbol('public', 'future.symbol').codepoint).toBe(0xe200)
    db.close()
  })
})

describe('stampSfSymbolCodepoints resume + partial coverage', () => {
  function seedCatalog(db) {
    db.upsertSfSymbol({ name: 'star', scope: 'public', categories: [], keywords: [], orderIndex: 0 })
    db.upsertSfSymbol({ name: 'heart', scope: 'public', categories: [], keywords: [], orderIndex: 1 })
    db.upsertSfSymbol({ name: 'moon', scope: 'public', categories: [], keywords: [], orderIndex: 2 })
    // 'star' is already stamped; 'heart' + 'moon' are missing.
    db.updateSfSymbolCodepoint('public', 'star', 0xe100)
  }

  test('only dumps the symbols still missing codepoints', async () => {
    const db = new DocsDatabase(':memory:')
    seedCatalog(db)
    const writes = []
    const result = await stampSfSymbolCodepoints(
      {
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        spawn: () => createEchoProc(() => 0xe000, writes),
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger: noopLogger },
    )
    const requestedNames = writes.join('').split('\n').filter(Boolean)
    expect(requestedNames.sort()).toEqual(['heart', 'moon'])
    expect(result.requested).toBe(2)
    expect(result.stamped).toBe(2)
    expect(result.missing).toBe(0)
    expect(result.total).toBe(3)
    // Previously-stamped row untouched; missing rows now stamped.
    expect(db.getSfSymbol('public', 'star').codepoint).toBe(0xe100)
    expect(db.getSfSymbol('public', 'heart').codepoint).toBe(0xe000)
    expect(db.getSfSymbol('public', 'moon').codepoint).toBe(0xe000)
    db.close()
  })

  test('forceRefresh re-dumps the whole catalog', async () => {
    const db = new DocsDatabase(':memory:')
    seedCatalog(db)
    const writes = []
    const result = await stampSfSymbolCodepoints(
      {
        forceRefresh: true,
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        spawn: () => createEchoProc(() => 0xe001, writes),
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger: noopLogger },
    )
    const requestedNames = writes.join('').split('\n').filter(Boolean)
    expect(requestedNames.sort()).toEqual(['heart', 'moon', 'star'])
    expect(result.requested).toBe(3)
    expect(result.stamped).toBe(3)
    expect(db.getSfSymbol('public', 'star').codepoint).toBe(0xe001)
    db.close()
  })

  test('short-circuits (no dump) when nothing is missing but fontPath forces past the gate', async () => {
    const db = new DocsDatabase(':memory:')
    seedCatalog(db)
    db.updateSfSymbolCodepoint('public', 'heart', 0xe101)
    db.updateSfSymbolCodepoint('public', 'moon', 0xe102)
    let spawned = 0
    const result = await stampSfSymbolCodepoints(
      {
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        spawn: () => { spawned++; return createEchoProc(() => 0xe000) },
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger: noopLogger },
    )
    expect(spawned).toBe(0)
    expect(result.skipped).toBe(true)
    expect(result.total).toBe(3)
    db.close()
  })

  test('partial dump warns loudly with the deficit and leaves NULLs for retry', async () => {
    const db = new DocsDatabase(':memory:')
    seedCatalog(db)
    const warnings = []
    const logger = { ...noopLogger, warn: m => warnings.push(m) }
    const result = await stampSfSymbolCodepoints(
      {
        fontPath: '/tmp/fake.otf',
        metadataDir: '/tmp/fake-metadata',
        // Worker dies after answering a single symbol.
        spawn: () => createEchoProc(() => 0xe000, [], { dieAfter: 1 }),
      },
      { db, dataDir: '/tmp/apple-docs-stamp-test', logger },
    )
    expect(result.stamped).toBe(1)
    expect(result.missing).toBe(1)
    expect(result.unanswered).toBe(1)
    expect(warnings.some(w => /dump ended early/.test(w))).toBe(true)
    // The unanswered symbol stays NULL so the next sync re-requests it.
    const nulls = db.db.query(
      "SELECT name FROM sf_symbols WHERE scope = 'public' AND codepoint IS NULL",
    ).all().map(r => r.name)
    expect(nulls.length).toBe(1)
    db.close()
  })
})

// ---- helpers ---------------------------------------------------------------

/**
 * Fake Swift worker: answers every name written to stdin, in order.
 * `writes` collects raw stdin payloads; `dieAfter` closes stdout after
 * N responses to simulate a mid-dump crash.
 */
function createEchoProc(codepointFor, writes = [], { dieAfter = Infinity } = {}) {
  let controller
  let answered = 0
  const encoder = new TextEncoder()
  const stdout = new ReadableStream({ start(c) { controller = c } })
  const stderr = new ReadableStream({ start(c) { c.close() } })
  const close = () => { try { controller.close() } catch {} }
  return {
    stdout,
    stderr,
    stdin: {
      write(text) {
        writes.push(text)
        for (const name of text.split('\n').filter(Boolean)) {
          if (answered >= dieAfter) { close(); return }
          controller.enqueue(encoder.encode(`${JSON.stringify({ name, codepoint: codepointFor(name) })}\n`))
          answered++
        }
      },
      flush() {},
      end: close,
    },
    kill: close,
  }
}
