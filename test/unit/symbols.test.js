import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DocsDatabase } from '../../src/storage/database.js'
import {
  _test as appleAssetsTest,
  getPrerenderedSymbolPath,
  renderSfSymbol,
  searchSfSymbols,
  syncSfSymbols,
} from '../../src/resources/apple-assets.js'

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

  test('filters catalog meta-names that are not real symbols', async () => {
    // Apple's plists embed "symbols" (catalog root) and "year_to_release"
    // (release pivot) alongside real symbol names. They have no
    // vectorGlyph drawable, so letting them through would force the
    // snapshot completeness validator to flag 14 × 4 = 56 phantom
    // missing renders. Verify they never enter sf_symbols.
    const contentsDir = join(tmp, 'CoreGlyphsMeta.bundle', 'Contents')
    const resourcesDir = join(contentsDir, 'Resources')
    await mkdir(resourcesDir, { recursive: true })
    await Bun.write(join(contentsDir, 'Info.plist'), plistDict({ CFBundleVersion: '1' }))
    await Bun.write(join(resourcesDir, 'symbol_order.plist'), plistArray([
      'symbols',
      'year_to_release',
      'pencil',
    ]))
    await Bun.write(join(resourcesDir, 'symbol_search.plist'), plistDict({
      symbols: ['root'],
      year_to_release: ['version'],
      pencil: ['write'],
    }))

    const count = await syncSfSymbols({ scope: 'public', bundleDir: resourcesDir }, ctx)
    expect(count).toBe(1)
    const names = db.listSfSymbolsCatalog().filter(s => s.scope === 'public').map(s => s.name)
    expect(names).toEqual(['pencil'])
    expect(names).not.toContain('symbols')
    expect(names).not.toContain('year_to_release')
  })

  test('maps snapshot variant paths for both scopes including weight/scale subdirs', () => {
    expect(getPrerenderedSymbolPath(ctx, 'public', 'pencil.and.sparkles', {
      weight: 'regular',
      scale: 'medium',
    })).toBe(join(tmp, 'resources', 'symbols', 'public', 'pencil.and.sparkles.svg'))
    expect(getPrerenderedSymbolPath(ctx, 'public', 'pencil.and.sparkles', {
      weight: 'bold',
      scale: 'large',
    })).toBe(join(tmp, 'resources', 'symbols', 'public', 'bold-large', 'pencil.and.sparkles.svg'))
    // Private now mirrors public: default variant at the scope root, non-default
    // variants under `<weight>-<scale>/`.
    expect(getPrerenderedSymbolPath(ctx, 'private', 'pencil.and.sparkles', {
      weight: 'regular',
      scale: 'medium',
    })).toBe(join(tmp, 'resources', 'symbols', 'private', 'pencil.and.sparkles.svg'))
    expect(getPrerenderedSymbolPath(ctx, 'private', 'pencil.and.sparkles', {
      weight: 'bold',
      scale: 'large',
    })).toBe(join(tmp, 'resources', 'symbols', 'private', 'bold-large', 'pencil.and.sparkles.svg'))

    expect(appleAssetsTest.symbolVariantMatrix('public')).toHaveLength(27)
    expect(appleAssetsTest.symbolVariantMatrix('private')).toHaveLength(27)
  })

  test('detects stale or incomplete pre-rendered symbol snapshots', async () => {
    const baseDir = join(tmp, 'resources', 'symbols')
    await mkdir(join(baseDir, 'public'), { recursive: true })
    await Bun.write(join(baseDir, 'public', 'pencil.and.sparkles.svg'), '<svg/>')

    expect(await appleAssetsTest.symbolSnapshotNeedsReset(baseDir)).toBe(true)

    await Bun.write(join(baseDir, 'meta.json'), JSON.stringify({
      rendererVersion: appleAssetsTest.symbolRendererVersion,
      variants: {
        public: appleAssetsTest.symbolVariantMatrix('public'),
        private: appleAssetsTest.symbolVariantMatrix('private'),
      },
    }))
    expect(await appleAssetsTest.symbolSnapshotNeedsReset(baseDir)).toBe(false)

    await Bun.write(join(baseDir, 'meta.json'), JSON.stringify({
      rendererVersion: appleAssetsTest.symbolRendererVersion,
      variants: {
        public: appleAssetsTest.symbolVariantMatrix('public').slice(0, -1),
        private: appleAssetsTest.symbolVariantMatrix('private'),
      },
    }))
    expect(await appleAssetsTest.symbolSnapshotNeedsReset(baseDir)).toBe(true)
  })

  test('customizes snapshot SVGs without recoloring mask cut-outs', () => {
    const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 10 20">
  <defs>
    <mask id="cut">
      <rect width="10" height="20" fill="#fff"/>
      <path d="M0 0h1v1z" fill="#000000"/>
    </mask>
  </defs>
  <path d="M1 1h8v18z" fill="#000000" mask="url(#cut)"/>
</svg>`

    const customized = appleAssetsTest.customizePrerenderedSymbolSvg(svg, {
      pointSize: 64,
      color: '#ff0000',
      background: '#00ff00',
    })

    expect(customized).toContain('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 10 20">')
    expect(customized).toContain('<path d="M0 0h1v1z" fill="#000000"/>')
    expect(customized).toContain('<path d="M1 1h8v18z" fill="#ff0000" mask="url(#cut)"/>')
    expect(customized).toContain('</defs>\n  <rect x="0" y="0" width="10" height="20" fill="#00ff00"/>')
  })

  test('renders SVG from snapshot geometry before live CoreGlyphs fallback', async () => {
    db.upsertSfSymbol({
      name: 'pencil.and.sparkles',
      scope: 'public',
      categories: ['editing'],
      keywords: ['sparkles', 'write'],
      orderIndex: 0,
    })
    const snapshotPath = getPrerenderedSymbolPath(ctx, 'public', 'pencil.and.sparkles', {
      weight: 'bold',
      scale: 'large',
    })
    await mkdir(dirname(snapshotPath), { recursive: true })
    await Bun.write(snapshotPath, `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 10 20">
  <defs><mask id="cut"><path d="M0 0h1v1z" fill="#000000"/></mask></defs>
  <path d="M1 1h8v18z" fill="#000000" mask="url(#cut)"/>
</svg>`)

    const render = await renderSfSymbol({
      scope: 'public',
      name: 'pencil.and.sparkles',
      format: 'svg',
      size: 64,
      color: '#ff0000',
      background: '#00ff00',
      weight: 'bold',
      scale: 'large',
    }, ctx)
    const output = await Bun.file(render.file_path).text()

    expect(render.mode).toBe('snapshot')
    expect(render.weight).toBe('bold')
    expect(render.symbol_scale).toBe('large')
    expect(render.mime_type).toBe('image/svg+xml; charset=utf-8')
    expect(output).toContain('width="64" height="64"')
    expect(output).toContain('<path d="M0 0h1v1z" fill="#000000"/>')
    expect(output).toContain('<path d="M1 1h8v18z" fill="#ff0000" mask="url(#cut)"/>')
    expect(output).toContain('<rect x="0" y="0" width="10" height="20" fill="#00ff00"/>')
  })

  test('F.3c: APPLE_DOCS_SYMBOLS_OFFLINE refuses live render on missing pre-render', async () => {
    db.upsertSfSymbol({
      name: 'orphan.symbol',
      scope: 'public',
      categories: [],
      keywords: [],
      orderIndex: 0,
    })

    const prev = process.env.APPLE_DOCS_SYMBOLS_OFFLINE
    process.env.APPLE_DOCS_SYMBOLS_OFFLINE = '1'
    try {
      await expect(
        renderSfSymbol({ scope: 'public', name: 'orphan.symbol', format: 'svg' }, ctx),
      ).rejects.toThrow(/offline mode|pre-render missing/i)
    } finally {
      if (prev === undefined) delete process.env.APPLE_DOCS_SYMBOLS_OFFLINE
      else process.env.APPLE_DOCS_SYMBOLS_OFFLINE = prev
    }
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
