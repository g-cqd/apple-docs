import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION, runMigrations } from '../../src/storage/migrations/index.js'

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
      db.query("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
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
