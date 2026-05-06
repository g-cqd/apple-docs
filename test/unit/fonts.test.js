import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { inspectSfntFile, listAppleFonts, parseFontFilename } from '../../src/resources/apple-assets.js'

let db
let tmp
let ctx

beforeEach(async () => {
  db = new DocsDatabase(':memory:')
  tmp = await mkdtemp(join(tmpdir(), 'apple-docs-fonts-test-'))
  ctx = { db, dataDir: tmp, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(async () => {
  db.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('Apple fonts', () => {
  test('upserts and lists Apple font families/files', () => {
    db.upsertAppleFontFamily({
      id: 'sf-pro',
      displayName: 'SF Pro',
      category: 'sans-serif',
      sourceUrl: 'https://example.com/SF-Pro.dmg',
    })
    db.upsertAppleFontFile({
      id: 'font-1',
      familyId: 'sf-pro',
      fileName: 'SF-Pro-Display-Bold.otf',
      filePath: join(tmp, 'SF-Pro-Display-Bold.otf'),
      format: 'otf',
      size: 12,
      source: 'remote',
      variant: 'Display',
      weight: 'Bold',
      italic: false,
      isVariable: false,
    })

    const result = listAppleFonts(ctx)
    expect(result.families).toHaveLength(1)
    expect(result.families[0].category).toBe('sans-serif')
    expect(result.families[0].files[0].id).toBe('font-1')
    expect(result.families[0].files[0].variant).toBe('Display')
    expect(result.families[0].files[0].weight).toBe('Bold')
    expect(result.families[0].files[0].italic).toBe(false)
    expect(result.families[0].files[0].source).toBe('remote')
  })

  test('parseFontFilename extracts variant, weight, italic from Apple naming conventions', () => {
    expect(parseFontFilename('SF-Pro-Display-BoldItalic.otf')).toEqual({
      variant: 'Display', weight: 'Bold', italic: true,
    })
    expect(parseFontFilename('SF-Pro-Italic.ttf')).toEqual({
      variant: null, weight: null, italic: true,
    })
    expect(parseFontFilename('NewYorkSmall-RegularItalic.otf')).toEqual({
      variant: 'Small', weight: 'Regular', italic: true,
    })
    expect(parseFontFilename('SF-Mono-Bold.otf')).toEqual({
      variant: null, weight: 'Bold', italic: false,
    })
    expect(parseFontFilename('SF-Pro.ttf')).toEqual({
      variant: null, weight: null, italic: false,
    })
    expect(parseFontFilename('SF-Pro-Rounded-Black.otf')).toEqual({
      variant: 'Rounded', weight: 'Black', italic: false,
    })
  })

  test('inspectSfntFile detects an fvar table and returns its axes', async () => {
    const fontPath = join(tmp, 'synthetic-vf.ttf')
    await writeFile(fontPath, buildSyntheticVariableFont())
    const result = inspectSfntFile(fontPath)
    expect(result.isVariable).toBe(true)
    expect(result.axes).toEqual([
      { tag: 'wght', min: 100, default: 400, max: 900 },
      { tag: 'wdth', min: 75, default: 100, max: 125 },
    ])
  })

  test('inspectSfntFile reports static when no fvar table is present', async () => {
    const fontPath = join(tmp, 'synthetic-static.ttf')
    await writeFile(fontPath, buildSyntheticStaticFont())
    const result = inspectSfntFile(fontPath)
    expect(result.isVariable).toBe(false)
    expect(result.axes).toEqual([])
  })
})

// ---- synthetic OpenType fixtures ------------------------------------------
//
// Just enough sfnt structure for `inspectSfntFile` to traverse: header,
// table directory with stub entries, and (in the variable variant) an
// `fvar` table. Other tables are stubbed with empty bodies. Real OpenType
// readers would complain, but our parser only touches the directory + fvar.

function buildSyntheticVariableFont() {
  const axes = [
    { tag: 'wght', min: 100, def: 400, max: 900 },
    { tag: 'wdth', min: 75, def: 100, max: 125 },
  ]
  const fvarBody = buildFvarTable(axes)
  return assembleSfnt([
    { tag: 'head', body: new Uint8Array(54) },
    { tag: 'fvar', body: fvarBody },
  ])
}

function buildSyntheticStaticFont() {
  return assembleSfnt([
    { tag: 'head', body: new Uint8Array(54) },
    { tag: 'cmap', body: new Uint8Array(8) },
  ])
}

function buildFvarTable(axes) {
  const offsetToAxes = 16
  const axisSize = 20
  const totalSize = offsetToAxes + axes.length * axisSize
  const bytes = new Uint8Array(totalSize)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 1)        // major version
  view.setUint16(2, 0)        // minor
  view.setUint16(4, offsetToAxes)
  view.setUint16(6, 2)        // pair count placeholder
  view.setUint16(8, axes.length)
  view.setUint16(10, axisSize)
  view.setUint16(12, 0)       // instance count
  view.setUint16(14, 0)       // instance size
  axes.forEach((axis, i) => {
    const start = offsetToAxes + i * axisSize
    bytes.set(new TextEncoder().encode(axis.tag), start)
    view.setInt32(start + 4, axis.min * 65536)
    view.setInt32(start + 8, axis.def * 65536)
    view.setInt32(start + 12, axis.max * 65536)
    view.setUint16(start + 16, 0)
    view.setUint16(start + 18, 0)
  })
  return bytes
}

function assembleSfnt(tables) {
  const numTables = tables.length
  const offsetTableSize = 12 + numTables * 16
  let bodyOffset = offsetTableSize
  const directoryEntries = tables.map(({ tag, body }) => {
    const entry = { tag, offset: bodyOffset, length: body.length, body }
    bodyOffset += body.length
    return entry
  })
  const total = bodyOffset
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, 0x00010000)        // sfnt version (TrueType)
  view.setUint16(4, numTables)
  view.setUint16(6, 0)                 // searchRange (we don't need accuracy)
  view.setUint16(8, 0)                 // entrySelector
  view.setUint16(10, 0)                // rangeShift
  directoryEntries.forEach((entry, i) => {
    const offset = 12 + i * 16
    bytes.set(new TextEncoder().encode(entry.tag), offset)
    view.setUint32(offset + 4, 0)      // checksum
    view.setUint32(offset + 8, entry.offset)
    view.setUint32(offset + 12, entry.length)
    bytes.set(entry.body, entry.offset)
  })
  return bytes
}
