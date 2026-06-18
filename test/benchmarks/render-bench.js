#!/usr/bin/env bun
// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)

/**
 * Render bench (RFC 0003 §3 ≥5× warm gate): in-process native render vs the
 * `swift script.swift` spawn, for font-text and symbol-pdf. darwin-only
 * (CoreText/AppKit + a `swift` toolchain).
 *
 *   bun test/benchmarks/render-bench.js [--iter 30]
 */

import { suffix } from 'bun:ffi'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { _forceImpl, nativeFontTextSvg, nativeSymbolPdf } from '../../src/resources/render-native.js'
import { FONT_TEXT_SCRIPT, SYMBOL_PDF_SCRIPT } from '../../src/resources/swift-templates.js'

if (process.platform !== 'darwin') {
  console.error('render-bench: darwin only')
  process.exit(2)
}
const DEV_LIB = new URL(`../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
process.env.APPLE_DOCS_NATIVE_LIB ??= existsSync(DEV_LIB) ? DEV_LIB : process.env.APPLE_DOCS_NATIVE_LIB
const ITER = (() => {
  const i = process.argv.indexOf('--iter')
  return i > -1 ? Number.parseInt(process.argv[i + 1], 10) || 30 : 30
})()

function p50(fn, n) {
  const xs = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    xs.push(performance.now() - t0)
  }
  xs.sort((a, b) => a - b)
  return xs[Math.floor(xs.length / 2)]
}

function spawn(script, args) {
  const dir = mkdtempSync(join(tmpdir(), 'render-bench-'))
  const sp = join(dir, 'r.swift')
  writeFileSync(sp, script)
  Bun.spawnSync(['swift', sp, ...args])
}

const fontsDir = join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'fonts', 'extracted')
const fontPath = join(fontsDir, 'sf-pro/SF-Pro-Italic.ttf')

function bench(label, nativeFn, spawnArgs, script) {
  _forceImpl('native')
  nativeFn() // warm
  const native = p50(nativeFn, ITER)
  _forceImpl(null)
  // spawn is the same cold ~200 ms each call by design (fresh JIT); a small
  // n keeps the bench quick.
  const spawnMs = p50(() => spawn(script, spawnArgs), Math.min(ITER, 8))
  console.log(`${label}: native ${native.toFixed(2)}ms vs spawn ${spawnMs.toFixed(0)}ms → ${(spawnMs / native).toFixed(0)}×`)
  return spawnMs / native
}

const ratios = []
ratios.push(
  bench('symbol-pdf', () => nativeSymbolPdf({ name: 'heart.fill', scope: 'public' }), ['heart.fill', 'public', 'regular', 'medium'], SYMBOL_PDF_SCRIPT),
)
if (existsSync(fontPath)) {
  ratios.push(bench('font-text', () => nativeFontTextSvg({ fontPath, text: 'Typography', pointSize: 96 }), [fontPath, 'Typography', '96'], FONT_TEXT_SCRIPT))
} else {
  console.log('font-text: skipped (corpus font absent)')
}
const min = Math.min(...ratios)
console.log(`\nRFC 0003 §3 gate ≥5×: ${min >= 5 ? 'MET' : 'FAILED'} (worst ${min.toFixed(0)}×)`)
