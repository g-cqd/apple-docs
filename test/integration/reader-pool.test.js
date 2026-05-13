import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { createReaderPool } from '../../src/storage/reader-pool.js'

// Exercises the pool end-to-end against real worker threads and a real
// temp-file SQLite database. :memory: cannot be used — each worker opens its
// own handle so the DB must live on disk for all workers to see the same
// contents.

let dbPath
let tmpDir
// Keep a main-thread handle open for the lifetime of the test file. Without
// it, SQLite tears down the WAL/SHM files when the seeding connection closes
// and then a burst of concurrent worker opens can race on WAL re-creation,
// producing transient `malformed database schema (sqlite_master)` fatals on
// x86 Darwin. Holding a single connection open is the canonical fix and
// matches production behavior (the MCP server has a long-lived writer).
let mainDb

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'apple-docs-reader-pool-'))
  dbPath = join(tmpDir, 'apple-docs.db')
  mainDb = new DocsDatabase(dbPath)
  const root = mainDb.upsertRoot('testfw', 'TestFramework', 'framework', 'test')
  mainDb.upsertPage({
    rootId: root.id,
    path: 'documentation/testfw/hello',
    url: 'u',
    title: 'Hello',
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: 'A minimal test symbol',
    declaration: 'struct Hello',
  })
  mainDb.upsertPage({
    rootId: root.id,
    path: 'documentation/testfw/world',
    url: 'u',
    title: 'World',
    role: 'symbol',
    roleHeading: 'Structure',
    abstract: 'Another minimal symbol',
    declaration: 'struct World',
  })
})

afterAll(() => {
  try { mainDb?.close?.() } catch {}
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('reader-pool (integration, real workers)', () => {
  // Per-test timeout 30s (vs Bun's 5s default). Every test in this
  // file spawns at least one real worker thread, opens a SQLite handle
  // inside it, runs the assertion, then awaits a clean pool.close().
  // On the 4-vCPU Ubuntu runner under Stryker's 8× concurrency, worker
  // startup alone can consume most of the 5s budget — `whitelist
  // rejects non-read ops` started flaking there on 2026-05-13, gating
  // every mutation run. 30s leaves room for the slow path without
  // hiding genuine hangs.
  const READER_POOL_TEST_TIMEOUT_MS = 30_000

  test('routes a getPage call through a worker and returns identical data', async () => {
    const pool = createReaderPool({ dbPath, size: 2 })
    await pool.start()
    try {
      const viaPool = await pool.run('getPage', ['documentation/testfw/hello'])
      expect(viaPool?.title).toBe('Hello')

      const viaMain = mainDb.getPage('documentation/testfw/hello')
      expect(viaPool?.title).toBe(viaMain?.title)
      expect(viaPool?.path).toBe(viaMain?.path)
    } finally {
      await pool.close()
    }
  }, READER_POOL_TEST_TIMEOUT_MS)

  test('parallel searchPages across multiple workers returns merged rows', async () => {
    const pool = createReaderPool({ dbPath, size: 3 })
    await pool.start()
    try {
      const calls = [
        pool.run('searchPages', ['"hello"*', 'hello', { limit: 10 }]),
        pool.run('searchPages', ['"world"*', 'world', { limit: 10 }]),
        pool.run('searchPages', ['"hello"*', 'hello', { limit: 10 }]),
      ]
      const results = await Promise.all(calls)
      expect(results).toHaveLength(3)
      for (const batch of results) {
        expect(Array.isArray(batch)).toBe(true)
      }
    } finally {
      await pool.close()
    }
  }, READER_POOL_TEST_TIMEOUT_MS)

  test('whitelist rejects non-read ops', async () => {
    const pool = createReaderPool({ dbPath, size: 1 })
    await pool.start()
    try {
      await expect(pool.run('upsertPage', [{}])).rejects.toThrow(/not in whitelist/)
    } finally {
      await pool.close()
    }
  }, READER_POOL_TEST_TIMEOUT_MS)

  test('fuzzyMatchTitles runs inside a worker and returns Levenshtein matches', async () => {
    const pool = createReaderPool({ dbPath, size: 1 })
    await pool.start()
    try {
      // 'Hellp' → 'Hello' → Levenshtein distance 1. With only 'Hello' and
      // 'World' in the corpus, the worker should pick Hello as the sole match.
      const matches = await pool.run('fuzzyMatchTitles', ['Hellp', { limit: 5 }])
      expect(Array.isArray(matches)).toBe(true)
      const titles = matches.map(m => m.title)
      expect(titles).toContain('Hello')
    } finally {
      await pool.close()
    }
  }, READER_POOL_TEST_TIMEOUT_MS)

  test('recycle reopens workers against the same DB file', async () => {
    const pool = createReaderPool({ dbPath, size: 2 })
    await pool.start()
    try {
      const before = pool.stats().spawns
      await pool.recycle()
      const after = pool.stats().spawns
      expect(after).toBe(before + 2)

      const out = await pool.run('getPage', ['documentation/testfw/world'])
      expect(out?.title).toBe('World')
    } finally {
      await pool.close()
    }
  }, READER_POOL_TEST_TIMEOUT_MS)
})
