/**
 * Logical SQLite content comparator for the W3 storage-writer parity gate
 * (RFC 0001 P5). Two DBs written by different engines (Bun `bun:sqlite` vs the
 * native ADSQL/ADStorage writer) are never byte-identical at the FILE level —
 * page layout, freelist, and rowid order differ — so the writer gate compares
 * LOGICAL content: every user table's row set, hashed and compared as an
 * order-independent multiset.
 *
 * Derived indexes (FTS5 / trigram shadow tables) are excluded — they are a
 * function of the base rows, and their internal segment layout is writer-
 * specific; FTS parity is proven separately by the search harness (cli-parity).
 * The byte-level guarantee belongs to the SNAPSHOT (VACUUM INTO normalizes the
 * layout, the deterministic tar.zst is sha256-checked) — see
 * snapshot-determinism.test.js.
 */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'

// FTS5/trigram shadow tables + SQLite internals — derived, not source-of-truth.
const SHADOW_RE = /_(data|idx|content|docsize|config)$|_fts$|_trigram$|^sqlite_/

/** @param {Database} db @param {string[]} ignoreTables @returns {string[]} */
function userTables(db, ignoreTables) {
  const rows = /** @type {Array<{ name: string }>} */ (db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all())
  return rows.map((r) => r.name).filter((n) => !SHADOW_RE.test(n) && !ignoreTables.includes(n))
}

/** @param {Database} db @param {string} table @returns {string[]} */
function tableColumns(db, table) {
  const rows = /** @type {Array<{ name: string }>} */ (db.query(`PRAGMA table_info("${table}")`).all())
  return rows.map((r) => r.name)
}

/** Stable, type-tagged hash of one row (array of column values). @param {unknown[]} values */
function hashRow(values) {
  const h = createHash('sha256')
  for (const v of values) {
    if (v === null || v === undefined) h.update('\x00N')
    else if (v instanceof Uint8Array) {
      h.update('\x00B')
      h.update(v)
    } else if (typeof v === 'bigint') h.update(`\x00I${v}`)
    else h.update(`\x00V${typeof v}:${v}`) // number / string
  }
  return h.digest('hex')
}

/** @param {Database} db @param {string} table @param {string[]} cols @returns {string[]} sorted row hashes */
function rowHashes(db, table, cols) {
  const list = cols.map((c) => `"${c}"`).join(', ')
  const rows = /** @type {unknown[][]} */ (db.query(`SELECT ${list} FROM "${table}"`).values())
  const hashes = rows.map(hashRow)
  hashes.sort()
  return hashes
}

/**
 * Compare two SQLite databases for logical content equivalence. Returns a list
 * of human-readable diffs (empty ⇒ equivalent). BLOBs are hashed; rows are
 * compared as an order-independent multiset; `ignoreColumns` drops volatile
 * fields (timestamps, live counters) that aren't part of the writer contract.
 *
 * @param {string} pathA
 * @param {string} pathB
 * @param {{ ignoreColumns?: string[], ignoreTables?: string[] }} [opts]
 * @returns {string[]}
 */
export function compareDatabases(pathA, pathB, opts = {}) {
  const ignoreColumns = opts.ignoreColumns ?? []
  const ignoreTables = opts.ignoreTables ?? []
  const a = new Database(pathA, { readonly: true })
  const b = new Database(pathB, { readonly: true })
  try {
    /** @type {string[]} */
    const diffs = []
    const tablesA = userTables(a, ignoreTables)
    const tablesB = userTables(b, ignoreTables)
    const setB = new Set(tablesB)
    const setA = new Set(tablesA)
    for (const t of tablesA) if (!setB.has(t)) diffs.push(`table only in A: ${t}`)
    for (const t of tablesB) if (!setA.has(t)) diffs.push(`table only in B: ${t}`)

    for (const t of tablesA) {
      if (!setB.has(t)) continue
      const colsA = tableColumns(a, t).filter((c) => !ignoreColumns.includes(c))
      const colsB = tableColumns(b, t).filter((c) => !ignoreColumns.includes(c))
      if (colsA.join(',') !== colsB.join(',')) {
        diffs.push(`${t}: column set differs (A=[${colsA}] B=[${colsB}])`)
        continue
      }
      const ha = rowHashes(a, t, colsA)
      const hb = rowHashes(b, t, colsB)
      if (ha.length !== hb.length) {
        diffs.push(`${t}: row count ${ha.length} (A) vs ${hb.length} (B)`)
        continue
      }
      const mismatches = ha.reduce((n, h, i) => n + (h === hb[i] ? 0 : 1), 0)
      if (mismatches > 0) diffs.push(`${t}: ${mismatches}/${ha.length} rows differ in content`)
    }
    return diffs
  } finally {
    a.close()
    b.close()
  }
}
