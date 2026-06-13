/**
 * WAL coexistence gate (RFC 0001 P5 first slice): the native read path
 * (dlopen'd libsqlite3) and the bun:sqlite WRITER touch the same real
 * SQLite file at once. Verifies no SQLITE_BUSY / corruption, read-your-
 * writes consistency across the two engines, and a bounded WAL (a native
 * read cursor must not starve the writer's autocheckpoint).
 *
 * Single-process interleave (writer commit → native reads), with several
 * native handles standing in for reader-pool workers — the genuine risk is
 * one sqlite build reading a WAL another build is actively committing.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _resetNativeLoader } from '../../src/native/loader.js'
import { DocsDatabase } from '../../src/storage/database.js'
import {
  _forceImpl,
  nativeSearchPages,
  nativeStorageClose,
  nativeStorageOpen,
} from '../../src/storage/storage-native.js'

const DEV_LIB = new URL(`../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const dylibPresent = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)

let dir
let dbPath
let db
const handles = []
let ready = false

// Probe at load (skip when this host's libsqlite3 lacks FTS5 → JS-fallback path).
if (dylibPresent) {
  process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
  _resetNativeLoader()
  _forceImpl('native')
  dir = mkdtempSync(join(tmpdir(), 'storage-wal-'))
  dbPath = join(dir, 'corpus.db')
  db = new DocsDatabase(dbPath)
  db.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  db.upsertDocument({ key: 'swiftui/view0', title: 'View0', framework: 'swiftui', sourceType: 'apple-docc', role: 'symbol', abstractText: 'A view seed.' })
  for (let i = 0; i < 4; i++) handles.push(nativeStorageOpen(dbPath))
  ready = handles.every((h) => h != null)
  if (!ready) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!ready)('storage-native WAL coexistence', () => {
  afterAll(() => {
    for (const h of handles) if (h != null) nativeStorageClose(h)
    db?.close()
    _forceImpl(null)
    if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('native handles opened alongside the bun:sqlite writer', () => {
    expect(handles.every((h) => typeof h === 'bigint')).toBe(true)
  })

  test('interleaved writer + native reads: no errors, read-your-writes, bounded WAL', () => {
    const ROUNDS = 250
    let lastCount = 0
    for (let r = 1; r <= ROUNDS; r++) {
      // bun:sqlite writer commits a new matching doc (autocommit).
      db.upsertDocument({
        key: `swiftui/view${r}`,
        title: `View${r}`,
        framework: 'swiftui',
        sourceType: 'apple-docc',
        role: 'symbol',
        abstractText: 'A view that participates in the WAL contention test.',
      })
      // Every native handle reads the live file — must succeed and observe a
      // non-decreasing, eventually-current count (committed writes visible).
      for (const h of handles) {
        const rows = nativeSearchPages(h, 'view', 'view', { framework: 'swiftui', limit: 1000 })
        expect(rows).not.toBeNull()
        expect(rows.length).toBeGreaterThanOrEqual(lastCount)
      }
      const probe = nativeSearchPages(handles[0], 'view', 'view', { framework: 'swiftui', limit: 1000 })
      lastCount = probe.length
    }
    // The writer committed 250 docs (+1 seed) all matching "view".
    expect(lastCount).toBeGreaterThanOrEqual(ROUNDS)

    // Bounded WAL: a native read cursor must not block the autocheckpoint
    // into unbounded growth. autocheckpoint=2000 pages (~8 MB); assert the
    // -wal stays well under a generous ceiling.
    const walPath = `${dbPath}-wal`
    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0
    expect(walBytes).toBeLessThan(16 * 1024 * 1024)
  })
})
