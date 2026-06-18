// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIGRATIONS, runMigrations, SCHEMA_VERSION } from '../../../src/storage/migrations/index.js'

let dataDir
let dbPath

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-mig-'))
  dbPath = join(dataDir, 'apple-docs.db')
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function readVersion(db) {
  const row = db.query('SELECT value FROM schema_meta WHERE key = ?').get('schema_version')
  return row ? Number.parseInt(row.value, 10) : null
}

describe('migrations', () => {
  test('SCHEMA_VERSION matches the highest migration version', () => {
    const max = MIGRATIONS.reduce((acc, m) => Math.max(acc, m.version), 0)
    expect(SCHEMA_VERSION).toBe(max)
  })

  test('migrations are listed in strictly ascending version order', () => {
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i].version).toBeGreaterThan(MIGRATIONS[i - 1].version)
    }
  })

  test('every migration exposes an up(db) function', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m.up).toBe('function')
    }
  })

  test('runMigrations on a fresh DB walks v0 → SCHEMA_VERSION', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    expect(readVersion(db)).toBe(SCHEMA_VERSION)
    db.close()
  })

  test('runMigrations is idempotent on a current DB', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const before = readVersion(db)
    runMigrations(db)
    runMigrations(db)
    expect(readVersion(db)).toBe(before)
    db.close()
  })

  test('a fresh DB ends with the canonical tables', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const tables = new Set(
      db
        .query("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    )
    for (const expected of [
      'schema_meta',
      'roots',
      'pages',
      'documents',
      'document_sections',
      'document_relationships',
      'crawl_state',
      'activity',
      'apple_font_families',
      'apple_font_files',
      'sf_symbols',
      'sf_symbol_renders',
    ]) {
      expect(tables.has(expected)).toBe(true)
    }
    db.close()
  })

  test('refuses to open a future-version DB (downgrade protection)', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    db.run("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", [String(SCHEMA_VERSION + 99)])
    expect(() => runMigrations(db)).toThrow(/newer than supported/)
    db.close()
  })

  test('migration failure rolls back the transaction', () => {
    const db = new Database(dbPath)
    // Plant a corrupt schema state: pretend we're at v5 so migrations 6+
    // have to run, but don't actually create the v1-v5 tables they expect.
    // The first dependent statement (v6 backfill from `pages`) should
    // throw and the migration runner should ROLLBACK.
    db.run('CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.run("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')")
    expect(() => runMigrations(db)).toThrow(/Migration from v5/)
    // schema_version stays at 5 (rolled back)
    expect(readVersion(db)).toBe(5)
    db.close()
  })
})

describe('v21 — drop legacy pages FTS + redundant relationship indexes', () => {
  const v21 = MIGRATIONS.find((m) => m.version === 21).up

  function names(db, type) {
    return new Set(
      db
        .query(`SELECT name FROM sqlite_master WHERE type='${type}'`)
        .all()
        .map((r) => r.name),
    )
  }

  test('drops the dead pages FTS tables and their maintenance triggers', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const tables = names(db, 'table')
    expect(tables.has('pages_fts')).toBe(false)
    expect(tables.has('titles_trigram')).toBe(false)
    expect(tables.has('pages_body_fts')).toBe(false)
    const triggers = names(db, 'trigger')
    expect(triggers.has('pages_ai')).toBe(false)
    expect(triggers.has('pages_ad')).toBe(false)
    expect(triggers.has('pages_au')).toBe(false)
    db.close()
  })

  test('keeps the load-bearing tables and the live documents FTS', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const tables = names(db, 'table')
    for (const keep of ['pages', 'document_relationships', 'documents_fts', 'documents_trigram', 'documents_body_fts']) {
      expect(tables.has(keep)).toBe(true)
    }
    db.close()
  })

  test('drops the redundant relationship indexes', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const indexes = names(db, 'index')
    expect(indexes.has('idx_rel_from')).toBe(false)
    expect(indexes.has('idx_rel_to')).toBe(false)
    db.close()
  })

  test('from_key lookups still resolve through the UNIQUE auto-index (no full scan)', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    const plan = db.query("EXPLAIN QUERY PLAN SELECT 1 FROM document_relationships WHERE from_key = 'x'").all()
    const detail = plan.map((r) => r.detail).join(' ')
    expect(detail).toContain('sqlite_autoindex_document_relationships_1')
    expect(detail).not.toContain('SCAN document_relationships')
    db.close()
  })

  test('a pages insert after migration does not throw (no dangling FTS trigger)', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    // Raw bun:sqlite connection has foreign_keys OFF, so root_id need not exist.
    expect(() => {
      db.run("INSERT INTO pages (root_id, path, url) VALUES (1, 'swiftui/view', 'https://example.com')")
    }).not.toThrow()
    db.close()
  })

  test('v21.up is idempotent (safe to re-run)', () => {
    const db = new Database(dbPath)
    runMigrations(db)
    expect(() => {
      v21(db)
      v21(db)
    }).not.toThrow()
    db.close()
  })
})
