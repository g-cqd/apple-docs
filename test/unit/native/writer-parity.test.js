// W3 storage-writer parity SCAFFOLD (RFC 0001 P5). The native ADSQL/ADStorage
// writer doesn't exist yet; this is the gate it will flip behind. It proves the
// three invariants the gate rests on, using the real JS writer (DocsDatabase)
// and the logical comparator (test/helpers/db-compare.js):
//
//   1. the JS writer is CONTENT-DETERMINISTIC (same input → same rows, modulo
//      wall-clock columns) — the prerequisite for any cross-writer parity claim;
//   2. the comparator actually CATCHES a divergence (no false green);
//   3. VACUUM INTO (the snapshot's DB-copy step) is BYTE-deterministic — the
//      basis of snapshot reproducibility.
//
// The cross-writer assertion (JS golden vs the native writer's DB) is skip-gated
// on AD_WRITER_DB: point it at a DB the native writer produced from the SAME
// fixture and it must compare equal (ids included — VACUUM preserves rowids, so
// id-stability is required for byte-identical snapshots).

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256File } from '../../../src/lib/hash.js'
import { DocsDatabase } from '../../../src/storage/database.js'
import { compareDatabases } from '../../helpers/db-compare.js'

// Wall-clock columns excluded from the writer contract — both writers stamp
// these with the current time, so they're not part of logical content parity.
const VOLATILE = [
  'first_seen',
  'last_seen',
  'downloaded_at',
  'created_at',
  'updated_at',
  'last_checked',
  'last_attempt',
  'last_success',
  'crawled_at',
  'checked_at',
  'timestamp',
  'started_at',
]

/** Build a small fixture corpus via the JS writer: root → pages (which also sync
 *  documents). Deterministic given a fixed input. @param {string} path */
function writeFixture(path) {
  const db = new DocsDatabase(path)
  const root = /** @type {{ id: number }} */ (db.upsertRoot('testfw', 'Test Framework', 'framework', 'test'))
  const pages = [
    { path: 'testfw', title: 'Test Framework', role: 'collection', roleHeading: 'Framework', abstract: 'The root.', declaration: null, language: null },
    { path: 'testfw/alpha', title: 'Alpha', role: 'symbol', roleHeading: 'Class', abstract: 'The alpha class.', declaration: 'class Alpha', language: 'swift' },
    {
      path: 'testfw/beta',
      title: 'Beta',
      role: 'symbol',
      roleHeading: 'Structure',
      abstract: 'The beta struct.',
      declaration: 'struct Beta',
      language: 'swift',
    },
  ]
  for (const pg of pages) {
    db.upsertPage({ rootId: root.id, ...pg, url: `https://developer.apple.com/documentation/${pg.path}`, platforms: '[]', contentHash: `h:${pg.path}` })
  }
  db.close()
}

describe('W3 writer parity — scaffold (gate for the native writer)', () => {
  /** @type {string} */
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wparity-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const p = (/** @type {string} */ n) => join(dir, n)

  test('JS writer is content-deterministic (same fixture twice → equal, modulo wall-clock columns)', () => {
    writeFixture(p('a.db'))
    writeFixture(p('b.db'))
    expect(compareDatabases(p('a.db'), p('b.db'), { ignoreColumns: VOLATILE })).toEqual([])
  })

  test('comparator catches a real content divergence (no false green)', () => {
    writeFixture(p('a.db'))
    const db = new DocsDatabase(p('c.db'))
    const root = /** @type {{ id: number }} */ (db.upsertRoot('testfw', 'Test Framework', 'framework', 'test'))
    db.upsertPage({
      rootId: root.id,
      path: 'testfw/alpha',
      title: 'DIVERGENT TITLE',
      role: 'symbol',
      url: 'https://developer.apple.com/documentation/testfw/alpha',
      platforms: '[]',
      contentHash: 'x',
    })
    db.close()
    expect(compareDatabases(p('a.db'), p('c.db'), { ignoreColumns: VOLATILE }).length).toBeGreaterThan(0)
  })

  test('VACUUM INTO is byte-deterministic (the snapshot DB-copy step)', async () => {
    writeFixture(p('src.db'))
    const src = new Database(p('src.db'))
    src.run(`VACUUM INTO '${p('v1.db')}'`)
    src.run(`VACUUM INTO '${p('v2.db')}'`)
    src.close()
    expect(await sha256File(p('v1.db'))).toBe(await sha256File(p('v2.db')))
  })

  // Cross-writer gate: skip until the operator points AD_WRITER_DB at a DB their
  // native writer produced from the SAME fixture as writeFixture().
  const nativeDb = process.env.AD_WRITER_DB
  const crossWriter = nativeDb && existsSync(nativeDb) ? test : test.skip
  crossWriter('native writer DB == JS golden (AD_WRITER_DB)', () => {
    writeFixture(p('golden.db'))
    expect(compareDatabases(p('golden.db'), /** @type {string} */ (nativeDb), { ignoreColumns: VOLATILE })).toEqual([])
  })
})
