import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _resetFontTextEngines, _resolveFontTextEngines, renderFontText } from '../../../src/resources/apple-fonts/render.js'
import { DocsDatabase } from '../../../src/storage/database.js'

const realWhich = Bun.which
const realPlatform = process.platform
let db
let dataDir

function stubPlatform(value) {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

beforeEach(() => {
  _resetFontTextEngines()
  delete process.env.APPLE_DOCS_FONT_RENDERER
  // Pin native render OFF so the engine-ordering contract is deterministic
  // regardless of whether a dev dylib is present (the in-dylib `hb-native`
  // engine is covered by shaper-parity.test.js). One case below flips it on.
  process.env.APPLE_DOCS_NATIVE = 'off'
  db = new DocsDatabase(':memory:')
  dataDir = mkdtempSync(join(tmpdir(), 'apple-docs-fontengine-'))
})

afterEach(() => {
  Bun.which = realWhich
  stubPlatform(realPlatform)
  delete process.env.APPLE_DOCS_FONT_RENDERER
  delete process.env.APPLE_DOCS_NATIVE
  _resetFontTextEngines()
  db.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('_resolveFontTextEngines', () => {
  test('darwin with hb-view installed: CoreText first, hb-view second', () => {
    stubPlatform('darwin')
    Bun.which = (bin) => (bin === 'hb-view' ? '/usr/local/bin/hb-view' : realWhich(bin))
    expect(_resolveFontTextEngines()).toEqual(['coretext', 'hb-view'])
  })

  test('linux with hb-view: hb-view only; without: no engines', () => {
    stubPlatform('linux')
    Bun.which = (bin) => (bin === 'hb-view' ? '/usr/bin/hb-view' : realWhich(bin))
    expect(_resolveFontTextEngines()).toEqual(['hb-view'])
    _resetFontTextEngines()
    Bun.which = (bin) => (bin === 'hb-view' ? null : realWhich(bin))
    expect(_resolveFontTextEngines()).toEqual([])
  })

  test('APPLE_DOCS_FONT_RENDERER pins a single engine (or none)', () => {
    process.env.APPLE_DOCS_FONT_RENDERER = 'hb-view'
    expect(_resolveFontTextEngines()).toEqual(['hb-view'])
    process.env.APPLE_DOCS_FONT_RENDERER = 'fallback'
    expect(_resolveFontTextEngines()).toEqual([])
  })
})

describe('renderFontText engine fallback', () => {
  function seedFont() {
    db.upsertAppleFontFamily({ id: 'sf-pro', displayName: 'SF Pro', status: 'available' })
    const dir = join(dataDir, 'resources', 'fonts', 'extracted', 'sf-pro')
    const path = join(dir, 'SF-Pro.otf')
    rmSync(dir, { recursive: true, force: true })
    require('node:fs').mkdirSync(dir, { recursive: true })
    // Valid SFNT magic so the probe passes; not a real font.
    writeFileSync(path, Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(64)]))
    db.upsertAppleFontFile({
      id: 'f'.repeat(24),
      familyId: 'sf-pro',
      fileName: 'SF-Pro.otf',
      filePath: path,
      source: 'remote',
      italic: false,
      isVariable: false,
      axes: [],
      size: 68,
    })
    return 'f'.repeat(24)
  }

  test('no engines → placeholder <text> SVG (never a throw)', async () => {
    process.env.APPLE_DOCS_FONT_RENDERER = 'fallback'
    const id = seedFont()
    const r = await renderFontText({ fontId: id, text: 'Hello' }, { db, dataDir, logger: { warn() {} } })
    expect(r.content).toContain('<text')
    expect(r.content).toContain('Hello')
  })

  test('a failing engine degrades to the placeholder', async () => {
    // hb-view on a 68-byte fake font fails (or the binary is absent) —
    // either way the loop must land on the placeholder.
    process.env.APPLE_DOCS_FONT_RENDERER = 'hb-view'
    const id = seedFont()
    const warnings = []
    const r = await renderFontText({ fontId: id, text: 'Hello' }, { db, dataDir, logger: { warn: (m) => warnings.push(m) } })
    expect(r.content).toContain('<text')
    expect(warnings.length).toBeGreaterThan(0)
  })
})

// Real-shaping integration: only when hb-view AND a real corpus font are
// available on this machine (dev Macs with a synced corpus; skipped on CI).
const hbView = realWhich('hb-view')
const realFont = join(homedir(), '.apple-docs', 'resources', 'fonts', 'extracted', 'sf-mono', 'SF-Mono-Regular.otf')
describe.skipIf(!hbView || !existsSync(realFont))('hb-view integration', () => {
  test('renders real glyph outlines as SVG', async () => {
    process.env.APPLE_DOCS_FONT_RENDERER = 'hb-view'
    db.upsertAppleFontFamily({ id: 'sf-mono', displayName: 'SF Mono', status: 'available' })
    db.upsertAppleFontFile({
      id: 'a'.repeat(24),
      familyId: 'sf-mono',
      fileName: 'SF-Mono-Regular.otf',
      filePath: realFont,
      source: 'remote',
      italic: false,
      isVariable: false,
      axes: [],
      size: 1,
    })
    const r = await renderFontText({ fontId: 'a'.repeat(24), text: 'Hello' }, { db, dataDir: join(homedir(), '.apple-docs'), logger: { warn() {} } })
    expect(r.content).toContain('<svg')
    expect(r.content).toContain('<path') // real outlines, not the <text> placeholder
    expect(r.content).not.toContain('<text')
  })
})
