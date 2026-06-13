/**
 * Tolerance parity gate for the Linux HarfBuzz shaper (RFC 0003 phase 4):
 * the in-dylib `ad_render_font_text_shaped` vs the hb-view host binary.
 *
 * The shaper runs the SAME HarfBuzz hb-view does, so glyph selection +
 * advances are identical; only the SVG serialisation differs. The gate is
 * therefore a TOLERANCE one (not byte-identical): rasterise both at 5×
 * supersample (washes out sub-pixel rasterisation phase — 3× left thin
 * strokes at small sizes right at the edge across rasteriser versions),
 * trim to the inked glyphs, and assert the trimmed dimensions match and
 * <2% of pixels differ beyond a 35% fuzz (which excludes anti-aliasing
 * edge noise — see scripts/shaper-spike.mjs, the spike that settled
 * D-0003-2; at 5× every matrix case sits at ~0%).
 *
 * Gated on the dylib + hb-view + rsvg-convert + magick + a test font all
 * being present. Apple's fonts aren't redistributable, so the corpus path
 * is used dev-locally; CI installs DejaVu (apt fonts-dejavu) + the tools.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { suffix } from 'bun:ffi'
import { _resetNativeLoader } from '../../../src/native/loader.js'
import { _forceImpl, nativeFontTextShaped } from '../../../src/resources/render-native.js'

const DEV_LIB = new URL(`../../../swift/.build/release/libAppleDocsCore.${suffix}`, import.meta.url).pathname
const nativeAvailable = !!process.env.APPLE_DOCS_NATIVE_LIB || existsSync(DEV_LIB)
const have = (bin) => !!Bun.which(bin)
// Legacy ImageMagick command names (work on IM6 = Ubuntu apt + IM7 = brew).
const tools = have('hb-view') && have('rsvg-convert') && have('compare') && have('convert') && have('identify')

const corpus = join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'fonts', 'extracted')
const FONT = [
  join(corpus, 'sf-mono', 'SF-Mono-Regular.otf'),
  join(corpus, 'sf-pro', 'SF-Pro-Display-Regular.otf'),
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
].find((p) => existsSync(p))

let dir
function sh(cmd) {
  const r = Bun.spawnSync(['bash', '-c', cmd])
  return { ok: r.exitCode === 0, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) }
}

function hbview(text, size) {
  const tf = join(dir, 'text.txt')
  writeFileSync(tf, text)
  const r = Bun.spawnSync(['hb-view', '--output-format=svg', '--background=FFFFFF00', `--font-size=${size}`, `--text-file=${tf}`, FONT])
  return r.exitCode === 0 ? new TextDecoder().decode(r.stdout) : null
}

// rasterise (3× supersample), trim, white-flatten → {png, w, h}.
function canon(svg, tag) {
  const sp = join(dir, `${tag}.svg`)
  const pp = join(dir, `${tag}.png`)
  writeFileSync(sp, svg)
  if (!sh(`rsvg-convert -f png --zoom 5 "${sp}" | convert - -trim +repage -background white -flatten "${pp}"`).ok) return null
  const id = sh(`identify -format '%w %h' "${pp}"`)
  const [w, h] = id.out.trim().split(' ').map(Number)
  return { pp, w, h }
}

function diffFraction(a, b) {
  const W = Math.max(a.w, b.w) + 4
  const H = Math.max(a.h, b.h) + 4
  const ext = (p, t) => {
    const o = join(dir, `${t}.ext.png`)
    sh(`convert "${p}" -background white -gravity NorthWest -extent ${W}x${H} "${o}"`)
    return o
  }
  const r = sh(`compare -metric AE -fuzz 35% "${ext(a.pp, 'a')}" "${ext(b.pp, 'b')}" null: 2>&1`)
  return (Number.parseInt((r.out || r.err).trim(), 10) || 0) / (W * H)
}

describe.skipIf(!nativeAvailable || !tools || !FONT)('shaper-parity (native HarfBuzz vs hb-view)', () => {
  beforeAll(() => {
    process.env.APPLE_DOCS_NATIVE_LIB ??= DEV_LIB
    _resetNativeLoader()
    _forceImpl('native')
    dir = mkdtempSync(join(tmpdir(), 'shaper-parity-'))
  })
  afterAll(() => {
    _forceImpl(null)
    if (process.env.APPLE_DOCS_NATIVE_LIB === DEV_LIB) delete process.env.APPLE_DOCS_NATIVE_LIB
    _resetNativeLoader()
    rmSync(dir, { recursive: true, force: true })
  })

  for (const c of [
    { text: 'Render', size: 96 },
    { text: 'Aa Bb 0123 &!', size: 72 },
  ]) {
    test(`native shaper ≈ hb-view: "${c.text}" @${c.size}`, () => {
      const native = nativeFontTextShaped({ fontPath: FONT, text: c.text, pointSize: c.size })
      expect(native).not.toBeNull()
      expect(native).toContain('<path d="M')
      const hv = hbview(c.text, c.size)
      expect(hv).not.toBeNull()
      const a = canon(native, 'n')
      const b = canon(hv, 'h')
      expect(a).not.toBeNull()
      expect(b).not.toBeNull()
      // Same glyph layout (trimmed bbox within a few supersampled px)...
      expect(Math.abs(a.w - b.w)).toBeLessThanOrEqual(10)
      expect(Math.abs(a.h - b.h)).toBeLessThanOrEqual(10)
      // ...and visually equivalent (only sub-AA edges differ).
      const frac = diffFraction(a, b)
      console.log(`  shaper-parity "${c.text}" @${c.size}: dims ${a.w}x${a.h} vs ${b.w}x${b.h}, meaningful-diff ${(frac * 100).toFixed(2)}%`)
      expect(frac).toBeLessThan(0.02)
    })
  }
})
