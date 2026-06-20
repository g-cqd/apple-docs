// Self-test for the W3 writer-parity comparator (test/helpers/db-compare.js):
// logical content equivalence — order-independent, BLOB-aware, column/table
// ignore lists, and the diff shapes the writer gate relies on.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareDatabases } from '../../helpers/db-compare.js'

/** @param {string} path @param {Array<[string, string|null, number, Uint8Array|null, number]>} rows */
function seed(path, rows) {
  const db = new Database(path)
  db.run('CREATE TABLE docs (key TEXT PRIMARY KEY, title TEXT, n INTEGER, blob BLOB, ts INTEGER)')
  const ins = db.query('INSERT INTO docs (key,title,n,blob,ts) VALUES (?,?,?,?,?)')
  for (const r of rows) ins.run(...r)
  db.close()
}

const ROWS = /** @type {Array<[string, string|null, number, Uint8Array|null, number]>} */ ([
  ['a', 'Alpha', 1, new Uint8Array([1, 2, 3]), 1000],
  ['b', 'Beta', 2, new Uint8Array([4, 5, 6]), 2000],
  ['c', null, 3, null, 3000],
])

describe('compareDatabases', () => {
  /** @type {string} */
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbcmp-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const p = (/** @type {string} */ n) => join(dir, n)

  test('identical content → no diffs', () => {
    seed(p('a.db'), ROWS)
    seed(p('b.db'), ROWS)
    expect(compareDatabases(p('a.db'), p('b.db'))).toEqual([])
  })

  test('order-independent: differing physical insert order → no diffs', () => {
    seed(p('a.db'), ROWS)
    seed(p('b.db'), [...ROWS].reverse())
    expect(compareDatabases(p('a.db'), p('b.db'))).toEqual([])
  })

  test('a mutated cell → content diff', () => {
    seed(p('a.db'), ROWS)
    seed(p('b.db'), [['a', 'ALPHA', 1, new Uint8Array([1, 2, 3]), 1000], ROWS[1], ROWS[2]])
    const diffs = compareDatabases(p('a.db'), p('b.db'))
    expect(diffs.length).toBe(1)
    expect(diffs[0]).toContain('docs:')
    expect(diffs[0]).toContain('rows differ')
  })

  test('a differing BLOB → content diff', () => {
    seed(p('a.db'), ROWS)
    seed(p('b.db'), [ROWS[0], ['b', 'Beta', 2, new Uint8Array([9, 9, 9]), 2000], ROWS[2]])
    expect(compareDatabases(p('a.db'), p('b.db')).some((d) => d.includes('rows differ'))).toBe(true)
  })

  test('an extra row → row-count diff', () => {
    seed(p('a.db'), ROWS)
    seed(p('b.db'), [...ROWS, ['d', 'Delta', 4, null, 4000]])
    expect(compareDatabases(p('a.db'), p('b.db')).some((d) => d.includes('row count'))).toBe(true)
  })

  test('ignoreColumns drops a volatile field (only ts differs)', () => {
    seed(p('a.db'), ROWS)
    seed(
      p('b.db'),
      ROWS.map((r) => /** @type {any} */ ([r[0], r[1], r[2], r[3], r[4] + 999])),
    )
    expect(compareDatabases(p('a.db'), p('b.db')).some((d) => d.includes('rows differ'))).toBe(true)
    expect(compareDatabases(p('a.db'), p('b.db'), { ignoreColumns: ['ts'] })).toEqual([])
  })

  test('a missing table → table-only diff', () => {
    seed(p('a.db'), ROWS)
    const b = new Database(p('b.db'))
    b.run('CREATE TABLE docs (key TEXT PRIMARY KEY, title TEXT, n INTEGER, blob BLOB, ts INTEGER)')
    b.run('CREATE TABLE extra (x INTEGER)')
    b.close()
    const diffs = compareDatabases(p('a.db'), p('b.db'))
    expect(diffs.some((d) => d.includes('table only in B: extra'))).toBe(true)
  })

  test('FTS5/shadow tables are excluded from the comparison', () => {
    // An fts shadow table present in only one DB must NOT register as a diff.
    seed(p('a.db'), ROWS)
    seed(p('b.db'), ROWS)
    const b = new Database(p('b.db'))
    b.run('CREATE TABLE docs_fts_data (id INTEGER PRIMARY KEY, block BLOB)')
    b.run("INSERT INTO docs_fts_data (block) VALUES (x'deadbeef')")
    b.close()
    expect(compareDatabases(p('a.db'), p('b.db'))).toEqual([])
  })
})
