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
