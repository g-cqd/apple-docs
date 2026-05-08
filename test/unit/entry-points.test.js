import { afterEach, describe, expect, test } from 'bun:test'
import {
  addEntryPoints,
  clearEntryPoints,
  getAllEntryPoints,
  getEntryPointsForParent,
} from '../../src/sources/entry-points.js'
// Side-effect imports: adapters self-register their entry points at module load.
import '../../src/sources/swift-docc.js'
import '../../src/sources/swift-book.js'

// Snapshot the entries registered by the imported adapters so each test can
// safely call `clearEntryPoints` for isolation and restore the baseline after.
const baseline = getAllEntryPoints()

afterEach(() => {
  clearEntryPoints()
  addEntryPoints(baseline)
})

describe('entry-points registry', () => {
  test('addEntryPoints filters out invalid entries', () => {
    clearEntryPoints()
    addEntryPoints([
      { key: 'a/b', title: 'A', parents: ['parent/x'] },
      { key: '', title: 'no-key', parents: ['parent/x'] }, // missing key — drop
      { key: 'a/c', title: 'no-parents' },                  // missing parents — drop
      { key: 'a/d', title: 'empty-parents', parents: [] }, // empty parents — drop
      null,
      undefined,
    ])
    expect(getAllEntryPoints().map(e => e.key)).toEqual(['a/b'])
  })

  test('addEntryPoints deduplicates entries with the same key + parents', () => {
    clearEntryPoints()
    addEntryPoints([{ key: 'x', title: 'X', parents: ['p'] }])
    addEntryPoints([{ key: 'x', title: 'X', parents: ['p'] }])
    expect(getAllEntryPoints()).toHaveLength(1)
  })

  test('addEntryPoints keeps separate entries when parents differ', () => {
    clearEntryPoints()
    addEntryPoints([{ key: 'x', title: 'X', parents: ['p1'] }])
    addEntryPoints([{ key: 'x', title: 'X', parents: ['p2'] }])
    expect(getAllEntryPoints()).toHaveLength(2)
  })

  test('getEntryPointsForParent returns matching entries', () => {
    clearEntryPoints()
    addEntryPoints([
      { key: 'a', title: 'A', parents: ['hub'] },
      { key: 'b', title: 'B', parents: ['hub', 'other'] },
      { key: 'c', title: 'C', parents: ['other'] },
    ])
    const titles = getEntryPointsForParent('hub').map(e => e.title)
    expect(titles).toEqual(['A', 'B'])
  })

  test('source adapters self-register their entry points at import time', () => {
    // Import order in baseline: SwiftDocc + SwiftBook adapters declare entry
    // points. The full set should include each archive root linking back to
    // swift-org/documentation.
    const docKeys = getEntryPointsForParent('swift-org/documentation').map(e => e.key)
    expect(docKeys).toContain('swift-compiler/documentation/diagnostics')
    expect(docKeys).toContain('swift-package-manager/documentation/packagemanagerdocs')
    expect(docKeys).toContain('swift-migration-guide/documentation/migrationguide')
    expect(docKeys).toContain('swift-book/The-Swift-Programming-Language')
  })
})
