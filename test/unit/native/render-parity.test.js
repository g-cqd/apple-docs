/**
 * Byte-parity gate for the Swift render port (RFC 0003 phase 1).
 *
 * darwin-only: the spawn leg needs `swift` + CoreText/AppKit, which the
 * Linux native CI runner lacks (Bun-only). The robust gate is
 * **native == spawn**, computed live, so it's OS-version-independent
 * (a frozen golden would drift as SF Symbols / fonts change across
 * macOS releases). Layers:
 *   - FFI smoke (always, darwin + dylib): exports wired, degrade to null;
 *   - symbol-pdf parity (always, darwin + dylib): public SF Symbols are
 *     present on the build OS → real CI macOS coverage;
 *   - font-text parity (skipped when corpus fonts absent — Apple fonts
 *     can't be redistributed, so CI skips it; dev runs it). Also pins the
 *     committed goldens, which the symbol leg keeps as reviewable
 *     reference only.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _resetNativeLoader } from '../../../src/native/loader.js'
import { _forceImpl, nativeFontTextSvg, nativeSymbolPdf } from '../../../src/resources/render-native.js'
import { FONT_TEXT_SCRIPT, SYMBOL_PDF_SCRIPT } from '../../../src/resources/swift-templates.js'
import { symbolPdfToSvg } from '../../../src/resources/symbol-pdf-to-svg.js'

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const nativeAvailable = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)
const isDarwin = process.platform === 'darwin'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'render-parity')
const manifest = JSON.parse(readFileSync(join(FIXTURES, 'manifest.json'), 'utf8'))
const fontsDir = join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'fonts', 'extracted')

function spawnScript(script, args) {
  const dir = mkdtempSync(join(tmpdir(), 'render-test-'))
  const scriptPath = join(dir, 'r.swift')
  writeFileSync(scriptPath, script)
  const res = Bun.spawnSync(['swift', scriptPath, ...args])
  return res.exitCode === 0 ? res.stdout : null
}

describe.skipIf(!isDarwin || !nativeAvailable)('render-native', () => {
  beforeAll(() => {
    process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
    _resetNativeLoader()
    _forceImpl('native')
  })
  afterAll(() => {
    _forceImpl(null)
    if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
  })

  test('the render FFI surface is wired and degrades to null', () => {
    expect(nativeFontTextSvg({ fontPath: '/nonexistent/font.ttf', text: 'x', pointSize: 96 })).toBeNull()
    expect(nativeFontTextSvg({ fontPath: 42, text: 'x', pointSize: 96 })).toBeNull()
    expect(nativeSymbolPdf({ name: 'definitely.not.a.real.symbol.xyz', scope: 'public' })).toBeNull()
  })

  // symbol-pdf: public SF Symbols exist on the build OS → runs in CI.
  for (const c of manifest.symbolCases) {
    test(`symbol-pdf native == spawn: ${c.symbol}`, () => {
      const nativePdf = nativeSymbolPdf({ name: c.symbol, scope: c.scope, weight: c.weight, scale: c.scale })
      expect(nativePdf).not.toBeNull()
      const spawnPdf = spawnScript(SYMBOL_PDF_SCRIPT, [c.symbol, c.scope, c.weight, c.scale])
      expect(spawnPdf).not.toBeNull()
      // Raw PDF carries non-deterministic metadata; gate on the SVG that's
      // actually cached + served.
      const nativeSvg = symbolPdfToSvg(nativePdf, { name: c.symbol })
      const spawnSvg = symbolPdfToSvg(new Uint8Array(spawnPdf), { name: c.symbol })
      expect(nativeSvg).toBe(spawnSvg)
    })
  }

  // font-text: needs corpus fonts (Apple fonts not redistributable → CI skips).
  for (const c of manifest.fontCases) {
    const fontPath = join(fontsDir, c.font)
    test.skipIf(!existsSync(fontPath))(`font-text native == spawn == golden: ${c.name}`, () => {
      const golden = readFileSync(join(FIXTURES, c.name), 'utf8')
      const native = nativeFontTextSvg({ fontPath, text: c.text, pointSize: c.size })
      expect(native).toBe(golden)
      const spawnSvg = new TextDecoder().decode(spawnScript(FONT_TEXT_SCRIPT, [fontPath, c.text, String(c.size)]))
      expect(spawnSvg).toBe(golden)
    })
  }
})
