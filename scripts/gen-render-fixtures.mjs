#!/usr/bin/env bun
/**
 * Generate test/fixtures/render-parity/ — committed golden SVGs for the
 * Swift render port (RFC 0003 phase 1). The goldens come from the SPAWN
 * path (the normative renderer); the parity test then asserts the native
 * in-dylib path reproduces them byte-for-byte.
 *
 * Apple's SF fonts can't be redistributed, so the golden inputs reference
 * fonts by their LOCAL corpus path and the byte-replay test skips when
 * they're absent (the embed-parity precedent) — dev runs it, CI builds +
 * smoke-tests the export. Deterministic: the spawn path is verified
 * byte-stable across two runs before any golden is frozen.
 *
 * Requires a populated $APPLE_DOCS_HOME with extracted fonts; darwin-only.
 */

import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FONT_TEXT_SCRIPT, SYMBOL_PDF_SCRIPT } from '../src/resources/swift-templates.js'
import { symbolPdfToSvg } from '../src/resources/symbol-pdf-to-svg.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'test', 'fixtures', 'render-parity')
const home = process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs')
const fontsDir = join(home, 'resources', 'fonts', 'extracted')

if (process.platform !== 'darwin') throw new Error('render fixtures need darwin (CoreText spawn)')

// A small, deterministic matrix across a couple of font families + faces.
const CASES = [
  { font: 'sf-pro/SF-Pro-Italic.ttf', text: 'Typography Hé!', size: 96 },
  { font: 'sf-pro/SF-Pro-Display-Thin.otf', text: 'Aa Bb 0123', size: 128 },
  { font: 'sf-compact/SF-Compact-Rounded-Medium.otf', text: 'Render & <Test>', size: 72 },
]

function spawnFontTextSvg(fontPath, text, size) {
  const dir = mkdtempSync(join(tmpdir(), 'render-fx-'))
  const scriptPath = join(dir, 'f.swift')
  writeFileSync(scriptPath, FONT_TEXT_SCRIPT)
  const res = Bun.spawnSync(['swift', scriptPath, fontPath, text, String(size)])
  if (res.exitCode !== 0) {
    throw new Error(`spawn failed for ${fontPath}: ${new TextDecoder().decode(res.stderr)}`)
  }
  return new TextDecoder().decode(res.stdout)
}

mkdirSync(OUT_DIR, { recursive: true })
const manifest = []
let i = 0
for (const c of CASES) {
  const fontPath = join(fontsDir, c.font)
  if (!existsSync(fontPath)) {
    console.warn(`skip (font absent): ${c.font}`)
    continue
  }
  // Determinism gate: the golden's premise is a byte-stable spawn.
  const a = spawnFontTextSvg(fontPath, c.text, c.size)
  const b = spawnFontTextSvg(fontPath, c.text, c.size)
  if (a !== b) throw new Error(`spawn output is NOT byte-stable for ${c.font} — cannot freeze a golden`)

  const name = `case-${i++}.svg`
  writeFileSync(join(OUT_DIR, name), a)
  manifest.push({ name, font: relative(fontsDir, fontPath), text: c.text, size: c.size, bytes: a.length })
  console.log(`wrote ${name} (${a.length} bytes) from ${c.font}`)
}

// --- symbol-pdf leg: public SF Symbols (present on the build OS, not the
// --- corpus) → PDF → symbolPdfToSvg → golden SVG. Darwin-only.
const SYMBOLS = [
  { name: 'heart.fill', scope: 'public' },
  { name: 'star', scope: 'public' },
  { name: 'house.fill', scope: 'public' },
  { name: 'gear', scope: 'public' },
]

function spawnSymbolPdf(name, scope, weight, scale) {
  const dir = mkdtempSync(join(tmpdir(), 'render-sym-'))
  const sp = join(dir, 's.swift')
  writeFileSync(sp, SYMBOL_PDF_SCRIPT)
  const res = Bun.spawnSync(['swift', sp, name, scope, weight, scale])
  return res.exitCode === 0 ? new Uint8Array(res.stdout) : null
}

const symbolManifest = []
let j = 0
for (const s of SYMBOLS) {
  const weight = 'regular'
  const scale = 'medium'
  const a = spawnSymbolPdf(s.name, s.scope, weight, scale)
  if (!a) {
    console.warn(`skip (symbol absent on this OS): ${s.name}`)
    continue
  }
  const b = spawnSymbolPdf(s.name, s.scope, weight, scale)
  // PDF bytes carry non-deterministic metadata; gate on the post-processed
  // SVG (what's actually cached + served).
  const svgA = symbolPdfToSvg(a, { name: s.name })
  const svgB = symbolPdfToSvg(b, { name: s.name })
  if (svgA !== svgB) throw new Error(`symbol SVG is NOT stable across two spawns for ${s.name}`)
  const name = `symbol-${j++}.svg`
  writeFileSync(join(OUT_DIR, name), svgA)
  symbolManifest.push({ name, symbol: s.name, scope: s.scope, weight, scale, bytes: svgA.length })
  console.log(`wrote ${name} (${svgA.length} bytes) from symbol ${s.name}`)
}

writeFileSync(
  join(OUT_DIR, 'manifest.json'),
  JSON.stringify(
    {
      note: 'fonts referenced by corpus-relative path (replay skips when absent); symbols are public SF Symbols present on the build OS',
      fontCases: manifest,
      symbolCases: symbolManifest,
    },
    null,
    1,
  ),
)
console.log(`wrote ${OUT_DIR}/manifest.json (${manifest.length} font + ${symbolManifest.length} symbol cases)`)
