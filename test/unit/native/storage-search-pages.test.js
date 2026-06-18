/**
 * A/B byte-parity gate for the native searchPages read path (RFC 0001 P5
 * first slice). The native side (libAppleDocsCore → dlopen'd libsqlite3)
 * must return the SAME rows bun:sqlite produces for the same query against
 * the same real-SQLite file — same values, types (number vs string, null
 * not undefined), and key order.
 *
 * Skipped when the dylib is absent (the Linux/macOS native CI job sets
 * APPLE_DOCS_NATIVE_LIB; a dev run uses the release build). The seed uses
 * the real DocsDatabase migrations so documents_fts / bm25 / the _num
 * companions all exist exactly as in production.
 */

import { suffix } from 'bun:ffi'
import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetNativeLoader } from '../../../src/native/loader.js'
import { DocsDatabase } from '../../../src/storage/database.js'
import { _forceImpl, nativeSearchPages, nativeStorageClose, nativeStorageOpen } from '../../../src/storage/storage-native.js'

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const dylibPresent = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)

let dir
let db
let handle
let ready = false

function seed(database) {
  database.upsertRoot('swiftui', 'SwiftUI', 'framework', 'test')
  database.upsertRoot('uikit', 'UIKit', 'framework', 'test')
  database.upsertRoot('foundation', 'Foundation', 'framework', 'test')
  const docs = [
    {
      key: 'swiftui/view',
      title: 'View',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'protocol',
      language: 'swift',
      abstractText: 'A type that represents part of your app interface.',
      urlDepth: 2,
      minIos: '13.0',
      minMacos: '10.15',
    },
    {
      key: 'swiftui/viewbuilder',
      title: 'ViewBuilder',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'struct',
      language: 'swift',
      abstractText: 'Constructs views from closures.',
      urlDepth: 2,
      minIos: '14.0',
    },
    {
      key: 'swiftui/contentview',
      title: 'ContentView',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'struct',
      language: 'swift',
      abstractText: 'The root view of the app.',
      urlDepth: 2,
      minIos: '15.0',
      isBeta: true,
    },
    {
      key: 'swiftui/canvas',
      title: 'Canvas',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'struct',
      language: 'swift',
      abstractText: 'Renders a 2D view with immediate mode drawing.',
      urlDepth: 2,
      minIos: '15.0',
    },
    {
      key: 'swiftui/legacyview',
      title: 'LegacyView',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'class',
      language: 'swift',
      abstractText: 'An old deprecated view API.',
      urlDepth: 2,
      isDeprecated: true,
      minIos: '13.0',
    },
    {
      key: 'swiftui/japanese',
      title: '小さなビュー',
      framework: 'swiftui',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'struct',
      language: 'swift',
      abstractText: 'A tiny view rendered in Japanese.',
      urlDepth: 2,
    },
    {
      key: 'uikit/uiview',
      title: 'UIView',
      framework: 'uikit',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'class',
      language: 'occ',
      abstractText: 'Manages the content for a rectangular view area.',
      urlDepth: 2,
      minIos: '2.0',
    },
    {
      key: 'uikit/uiviewcontroller',
      title: 'UIViewController',
      framework: 'uikit',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'class',
      language: 'occ',
      abstractText: 'An object that manages a view hierarchy.',
      urlDepth: 2,
      minIos: '2.0',
      isReleaseNotes: false,
    },
    {
      key: 'foundation/url',
      title: 'URL',
      framework: 'foundation',
      sourceType: 'apple-docc',
      role: 'symbol',
      kind: 'struct',
      language: 'swift',
      abstractText: 'A value identifying the location of a resource.',
      urlDepth: 2,
    },
    {
      key: 'wwdc/2023/great-views',
      title: 'Build great views',
      framework: 'wwdc',
      sourceType: 'wwdc',
      role: 'article',
      language: 'both',
      abstractText: 'A session about building views and view layout.',
      urlDepth: 3,
      sourceMetadata: { year: 2023, track: 'SwiftUI & UI Frameworks' },
    },
  ]
  for (const d of docs) database.upsertDocument(d)
}

// [name, ftsQuery, rawQuery, opts]
const CASES = [
  ['plain term, tier ordering', 'view', 'view', {}],
  ['exact-title tier 0', 'view', 'View', {}],
  ['prefix-title tier 1', 'viewbuilder', 'View', {}],
  ['framework filter', 'view', 'view', { framework: 'swiftui' }],
  ['source_type filter', 'view', 'view', { sourceType: 'wwdc' }],
  ['multi-source filter', 'view', 'view', { sources: ['apple-docc', 'wwdc'] }],
  ['kind filter', 'view', 'view', { kind: 'struct' }],
  ['language filter swift', 'view', 'view', { language: 'swift' }],
  ['language filter occ', 'view', 'view', { language: 'occ' }],
  ['deprecated exclude', 'view', 'view', { deprecatedMode: 'exclude' }],
  ['deprecated only', 'view', 'view', { deprecatedMode: 'only' }],
  ['min_ios filter', 'view', 'view', { minIos: '14.0' }],
  ['year filter', 'view', 'view', { year: 2023 }],
  ['track filter', 'view', 'view', { track: 'swiftui' }],
  ['limit', 'view', 'view', { limit: 3 }],
  ['empty result', 'zzzznomatch', 'zzzznomatch', {}],
  ['combined filters', 'view', 'view', { framework: 'swiftui', kind: 'struct', deprecatedMode: 'exclude', limit: 5 }],
]

// Probe at load: a null handle when the dylib IS present means this host's
// libsqlite3 is absent or lacks FTS5 — the documented JS-fallback path, so
// the suite skips rather than failing the parity gate.
if (dylibPresent) {
  process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
  _resetNativeLoader()
  _forceImpl('native')
  dir = mkdtempSync(join(tmpdir(), 'storage-parity-'))
  db = new DocsDatabase(join(dir, 'corpus.db'))
  seed(db)
  handle = nativeStorageOpen(join(dir, 'corpus.db'))
  ready = handle != null
  if (!ready) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe.skipIf(!ready)('storage-native searchPages parity', () => {
  afterAll(() => {
    if (handle != null) nativeStorageClose(handle)
    db?.close()
    _forceImpl(null)
    if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('native handle opens (dylib + FTS5 present)', () => {
    expect(handle).not.toBeNull()
    expect(typeof handle).toBe('bigint')
  })

  for (const [name, ftsQuery, rawQuery, opts] of CASES) {
    test(`parity: ${name}`, () => {
      const jsRows = db.searchPages(ftsQuery, rawQuery, opts)
      const nativeRows = nativeSearchPages(handle, ftsQuery, rawQuery, opts)
      // Native must actually serve (not fall back) for the gate to mean anything.
      expect(nativeRows).not.toBeNull()
      expect(nativeRows.length).toBe(jsRows.length)
      // Row order + identity (the operationally-significant property).
      expect(nativeRows.map((r) => r.path)).toStrictEqual(jsRows.map((r) => r.path))
      for (let i = 0; i < jsRows.length; i++) {
        // Key insertion order matches bun:sqlite's column order.
        expect(Object.keys(nativeRows[i])).toStrictEqual(Object.keys(jsRows[i]))
        // Full byte-parity: values + types (null not undefined, number vs string).
        expect(nativeRows[i]).toStrictEqual(jsRows[i])
      }
    })
  }
})
