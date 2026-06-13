#!/usr/bin/env bun
/**
 * Phase-4 shaper spike (RFC 0003, settles D-0003-2): does the dlopen'd
 * HarfBuzz shaper (ad_render_font_text_shaped) match hb-view within
 * tolerance across Latin / RTL / combining marks? Both run the SAME
 * HarfBuzz, so shaping is identical; only the SVG serialisation differs.
 * The gate is a rasterised pixel diff: render native + hb-view → PNG, trim
 * to content, normalise to a common canvas, RMSE via ImageMagick.
 *
 * darwin-local: needs hb-view, rsvg-convert, magick (Homebrew), the
 * dlopen'd libharfbuzz, and a populated corpus.  bun scripts/shaper-spike.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _forceImpl, nativeFontTextShaped } from '../src/resources/render-native.js'

process.env.APPLE_DOCS_NATIVE_LIB ??= new URL(`../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
_forceImpl('native')

const FONTS = join(homedir(), '.apple-docs', 'resources', 'fonts', 'extracted')
const CASES = [
  { label: 'latin', font: 'sf-pro/SF-Pro-Display-Regular.otf', text: 'Typography', size: 96 },
  { label: 'latin-mixed', font: 'sf-pro/SF-Pro-Display-Medium.otf', text: 'Aa Bb 0123 &!', size: 80 },
  { label: 'combining', font: 'sf-pro/SF-Pro-Display-Regular.otf', text: 'é à ö Hé!', size: 96 },
  { label: 'mono', font: 'sf-mono/SF-Mono-Regular.otf', text: 'fn main()', size: 72 },
  { label: 'rtl-arabic', font: 'sf-arabic/SF-Arabic.ttf', text: 'مرحبا بالعالم', size: 96 },
  { label: 'rtl-hebrew', font: 'sf-hebrew/SF-Hebrew.ttf', text: 'שלום עולם', size: 96 },
]

const dir = mkdtempSync(join(tmpdir(), 'shaper-spike-'))
function sh(cmd) {
  const r = Bun.spawnSync(['bash', '-c', cmd])
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) }
}

function hbviewSvg(fontPath, text, size) {
  const tf = join(dir, 'text.txt')
  writeFileSync(tf, text)
  const r = Bun.spawnSync(['hb-view', '--output-format=svg', '--background=FFFFFF00', `--font-size=${size}`, `--text-file=${tf}`, fontPath])
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null
}

// rasterise an SVG → trimmed, white-flattened PNG (the two engines have
// different viewBoxes, so trim to the inked glyphs — identical trimmed dims
// then prove the layout/geometry match).
function toCanon(svg, tag) {
  const svgPath = join(dir, `${tag}.svg`)
  const pngPath = join(dir, `${tag}.png`)
  writeFileSync(svgPath, svg)
  // 3× supersample: the two engines anchor glyphs at different fractional
  // viewBox origins, so a 1× raster compares them at different sub-pixel
  // phases (AA-edge noise). Supersampling washes the phase out — what's
  // left is genuine geometry difference.
  const r = sh(`rsvg-convert -f png --zoom 3 "${svgPath}" | magick - -trim +repage -background white -flatten "${pngPath}"`)
  if (!r.ok) return null
  const id = sh(`magick identify -format '%w %h' "${pngPath}"`)
  const [w, h] = id.out.trim().split(' ').map(Number)
  return { pngPath, w, h }
}

// Extent both to a common top-left canvas (no distortion) and report the
// fraction of pixels that differ by more than `fuzz` (the meaningful-diff
// gate — robust to anti-aliasing edge noise) plus normalised RMSE.
function compare(a, b) {
  const W = Math.max(a.w, b.w) + 4
  const H = Math.max(a.h, b.h) + 4
  const ext = (p, t) => {
    const out = join(dir, `${t}.ext.png`)
    sh(`magick "${p}" -background white -gravity NorthWest -extent ${W}x${H} "${out}"`)
    return out
  }
  // 35% fuzz excludes anti-aliasing edge halos (the spike showed the diff
  // collapses to 0 by 40% fuzz — every differing pixel is a sub-AA edge,
  // not a wrong/shifted glyph). What's left is genuine structural difference.
  const ae = sh(`magick compare -metric AE -fuzz 35% "${ext(a.pngPath, 'a')}" "${ext(b.pngPath, 'b')}" null: 2>&1`)
  const rm = sh(`magick compare -metric RMSE "${ext(a.pngPath, 'a')}" "${ext(b.pngPath, 'b')}" null: 2>&1`)
  const aeCount = Number.parseInt((ae.out || ae.err).trim(), 10) || 0
  const rmse = Number.parseFloat(((rm.out || rm.err).match(/\(([\d.eE+-]+)\)/) || [])[1] ?? 'NaN')
  return { diffFrac: aeCount / (W * H), rmse }
}

// Structural gate: < this fraction of pixels differ beyond 35% fuzz at 3×
// supersample. AA + thin-stroke phase residual lives under it (the spike
// showed every case converges to ~0 with more supersampling); a wrong or
// shifted glyph blows well past it.
const THRESHOLD = 0.02
let worst = 0
let failed = 0
console.log(`spike: native HarfBuzz shaper vs hb-view — gate: meaningful-diff fraction < ${THRESHOLD}\n`)
for (const c of CASES) {
  const fontPath = join(FONTS, c.font)
  const native = nativeFontTextShaped({ fontPath, text: c.text, pointSize: c.size })
  const hv = hbviewSvg(fontPath, c.text, c.size)
  if (!native || !hv) {
    console.log(`  ${c.label.padEnd(12)} — ${!native ? 'native NULL' : 'hb-view failed'} (font ${c.font})`)
    failed++
    continue
  }
  const a = toCanon(native, `${c.label}-n`)
  const b = toCanon(hv, `${c.label}-h`)
  if (!a || !b) { console.log(`  ${c.label.padEnd(12)} — rasterise failed`); failed++; continue }
  const dimMatch = Math.abs(a.w - b.w) <= 6 && Math.abs(a.h - b.h) <= 6 // 3× supersample → ±6px
  const { diffFrac, rmse } = compare(a, b)
  worst = Math.max(worst, diffFrac)
  const ok = dimMatch && diffFrac < THRESHOLD
  if (!ok) failed++
  console.log(`  ${c.label.padEnd(12)} dims ${a.w}x${a.h} vs ${b.w}x${b.h} ${dimMatch ? '=' : '≠'} | diff ${(diffFrac * 100).toFixed(2)}% RMSE ${rmse.toFixed(4)}  ${ok ? 'OK' : 'DIVERGENT'}`)
}
rmSync(dir, { recursive: true, force: true })
console.log(`\nworst meaningful-diff ${(worst * 100).toFixed(2)}% (gate < ${(THRESHOLD * 100)}%) — ${failed === 0 ? 'SPIKE: GO' : `SPIKE: ${failed} case(s) DIVERGENT`}`)
process.exit(failed === 0 ? 0 : 1)
