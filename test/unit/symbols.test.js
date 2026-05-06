import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import { searchSfSymbols, syncSfSymbols } from '../../src/resources/apple-assets.js'

let db
let tmp
let ctx

beforeEach(async () => {
  db = new DocsDatabase(':memory:')
  tmp = await mkdtemp(join(tmpdir(), 'apple-docs-symbols-test-'))
  ctx = { db, dataDir: tmp, logger: { info() {}, warn() {}, error() {} } }
})

afterEach(async () => {
  db.close()
  await rm(tmp, { recursive: true, force: true })
})

describe('SF Symbols', () => {
  test('syncs public/private SF Symbols from CoreGlyphs-style plists', async () => {
    const contentsDir = join(tmp, 'CoreGlyphs.bundle', 'Contents')
    const resourcesDir = join(contentsDir, 'Resources')
    await mkdir(resourcesDir, { recursive: true })
    await Bun.write(join(contentsDir, 'Info.plist'), plistDict({
      CFBundleVersion: '1',
    }))
    await Bun.write(join(resourcesDir, 'symbol_order.plist'), plistArray([
      'pencil.and.sparkles',
      'text.below.rectangle',
    ]))
    await Bun.write(join(resourcesDir, 'symbol_search.plist'), plistDict({
      'pencil.and.sparkles': ['write', 'sparkles'],
      'text.below.rectangle': ['text', 'layout'],
    }))
    await Bun.write(join(resourcesDir, 'symbol_categories.plist'), plistDict({
      'pencil.and.sparkles': ['editing'],
    }))
    await Bun.write(join(resourcesDir, 'name_availability.plist'), plistDict({
      'pencil.and.sparkles': { macOS: '15.0' },
    }))

    const count = await syncSfSymbols({ scope: 'private', bundleDir: resourcesDir }, ctx)
    expect(count).toBe(2)

    const result = searchSfSymbols('sparkles', { scope: 'private' }, ctx)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].name).toBe('pencil.and.sparkles')
    expect(result.results[0].categories).toEqual(['editing'])
    expect(result.results[0].availability.macOS).toBe('15.0')

    await Bun.write(join(resourcesDir, 'symbol_search.plist'), plistDict({
      'pencil.and.sparkles': ['updated'],
      'text.below.rectangle': ['text', 'layout'],
    }))
    await syncSfSymbols({ scope: 'private', bundleDir: resourcesDir }, ctx)
    const refreshed = searchSfSymbols('updated', { scope: 'private' }, ctx)
    expect(refreshed.results.map(symbol => symbol.name)).toEqual(['pencil.and.sparkles'])

    const catalog = db.listSfSymbolsCatalog()
    expect(catalog).toHaveLength(2)
    expect(catalog.find(symbol => symbol.name === 'pencil.and.sparkles')?.categories).toEqual(['editing'])
  })
})

function plistArray(values) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
${values.map(value => `  <string>${escapeXml(value)}</string>`).join('\n')}
</array>
</plist>
`
}

function plistDict(object) {
  const entries = Object.entries(object).map(([key, value]) => `  <key>${escapeXml(key)}</key>\n${plistValue(value, 1)}`)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.join('\n')}
</dict>
</plist>
`
}

function plistValue(value, depth) {
  const pad = '  '.repeat(depth)
  if (Array.isArray(value)) {
    return `${pad}<array>\n${value.map(item => plistValue(item, depth + 1)).join('\n')}\n${pad}</array>`
  }
  if (value && typeof value === 'object') {
    return `${pad}<dict>\n${Object.entries(value).map(([k, v]) => `${pad}  <key>${escapeXml(k)}</key>\n${plistValue(v, depth + 1)}`).join('\n')}\n${pad}</dict>`
  }
  return `${pad}<string>${escapeXml(value)}</string>`
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
