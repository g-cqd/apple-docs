/**
 * Font preview renderer.
 *
 * Spawns Swift+CoreText to lay out the user's text in the requested font and
 * walks every glyph's path into a theme-neutral SVG. The Swift script lives
 * verbatim in resources/swift-templates.js so this module stays small and
 * the script body can be diffed independently.
 */

import { rm } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import {
  clampInteger,
  escapeXml,
} from '../apple-assets-helpers.js'
import { isLikelySfnt } from './sfnt.js'
import { assertFontPathContained } from './safe-font-path.js'
import { FONT_TEXT_SCRIPT } from '../swift-templates.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'

const ENGINE_ENV = 'APPLE_DOCS_FONT_RENDERER'
let enginesCache // string[] | undefined

/**
 * Ordered glyph-render engines for this host. darwin: CoreText first
 * (Apple's own shaping), hb-view second so a Mac without the Swift
 * toolchain still renders real glyphs. Elsewhere: hb-view (HarfBuzz —
 * full shaping incl. RTL/complex scripts) when installed. The
 * placeholder `<text>` SVG stays the terminal fallback either way.
 * `APPLE_DOCS_FONT_RENDERER=coretext|hb-view|fallback` pins one engine
 * (tests, diagnostics).
 */
export function _resolveFontTextEngines() {
  const forced = process.env[ENGINE_ENV]
  if (forced) return forced === 'fallback' ? [] : [forced]
  if (enginesCache) return enginesCache
  const engines = []
  if (process.platform === 'darwin') engines.push('coretext')
  if (Bun.which('hb-view')) engines.push('hb-view')
  enginesCache = engines
  return engines
}

/** Test seam: drop the memoized engine probe. */
export function _resetFontTextEngines() {
  enginesCache = undefined
}

export async function renderFontText(opts, ctx) {
  const font = ctx.db.getAppleFontFile(opts.fontId)
  if (!font) throw new NotFoundError(opts.fontId, `Font file not found: ${opts.fontId}`)
  const text = String(opts.text ?? 'Typography')
  const pointSize = clampInteger(opts.size ?? 96, 8, 512)
  let content
  // refuse to feed a non-allowlisted path to CoreText / Swift.
  // Surfaces as a placeholder SVG so the user sees a clean fallback
  // rather than a 500.
  let safeFontPath
  try {
    safeFontPath = assertFontPathContained(font.file_path, ctx.dataDir)
  } catch (error) {
    ctx.logger?.warn?.(`renderFontText: refused unsafe path for ${font.id}: ${error.message}`)
    return {
      font, text, format: 'svg',
      mimeType: 'image/svg+xml; charset=utf-8',
      content: renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize }),
    }
  }
  // CoreText / CTFontManagerRegisterFontsForURL behaviour on a non-SFNT
  // file is "undefined" in practice — observed to either segfault, register
  // a phantom descriptor, or stall indefinitely on macOS CI runners (the
  // last case wedges the request handler and the server eventually drops
  // listening for the test fetch). Probe the magic header up-front so test
  // fixtures and corrupt downloads short-circuit straight to the placeholder
  // SVG without spawning Swift.
  const valid = await isLikelySfnt(safeFontPath)
  if (valid) {
    for (const engine of _resolveFontTextEngines()) {
      try {
        content = engine === 'hb-view'
          ? await renderFontTextSvgHarfBuzz({ fontPath: safeFontPath, text, pointSize })
          : await renderFontTextSvgCurves({ fontPath: safeFontPath, text, pointSize })
        if (content) break
      } catch (error) {
        ctx.logger?.warn?.(`${engine} outline render failed for ${font.file_name}: ${error.message}`)
      }
    }
  }
  if (!content) {
    content = renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize })
  }
  return {
    font,
    text,
    format: 'svg',
    mimeType: 'image/svg+xml; charset=utf-8',
    content,
  }
}

function renderFontTextSvgFallback({ fontFamily, text, pointSize }) {
  const height = Math.ceil(pointSize * 1.6)
  const width = Math.max(240, Math.ceil(text.length * pointSize * 0.62))
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(text)}">
  <text x="0" y="${Math.ceil(pointSize * 1.1)}" font-family="${escapeXml(fontFamily)}" font-size="${pointSize}" fill="black">${escapeXml(text)}</text>
</svg>`
}

/**
 * HarfBuzz path: `hb-view` lays the text out with full shaping and emits
 * an SVG of glyph outlines — black glyphs on a transparent background,
 * the same visual contract as the CoreText script. The text travels via
 * a temp FILE, not argv: argv conversion needs a UTF-8 locale (C-locale
 * Linux containers reject non-ASCII arguments with "Invalid byte
 * sequence"), and a file can never be parsed as an option either.
 */
async function renderFontTextSvgHarfBuzz({ fontPath, text, pointSize }) {
  const stagingDir = mkdtempSync(join(tmpdir(), 'apple-docs-hb-text-'))
  const textPath = join(stagingDir, 'text.txt')
  await Bun.write(textPath, text)
  try {
    const { stdout, stderr, exitCode } = await spawnWithDeadline(
      ['hb-view', '--output-format=svg', '--background=FFFFFF00', `--font-size=${pointSize}`, `--text-file=${textPath}`, fontPath],
      { deadlineMs: 10_000 },
    )
    if (exitCode !== 0) throw new ValidationError(stderr.trim() || `hb-view exited ${exitCode}`)
    const svg = new TextDecoder().decode(stdout)
    if (!svg.includes('<svg')) throw new ValidationError('hb-view produced no SVG output')
    // hb-view exits 0 even when the font yields no outlines (corrupt file →
    // empty glyph defs). Visible text with zero paths is a failed render —
    // let the chain fall through to the next engine / the placeholder.
    if (/\S/.test(text) && !svg.includes('<path')) {
      throw new ValidationError('hb-view produced no glyph outlines (font unreadable?)')
    }
    return svg
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

async function renderFontTextSvgCurves({ fontPath, text, pointSize }) {
  // Stage the Swift driver in a per-call mkdtemp dir so the script path
  // is unguessable (kernel-allocated random suffix, mode 0700). Closes
  // the symlink-race window an `apple-docs-render-font-<pid>-<n>.swift`
  // path under /tmp would leave open on a shared host.
  const stagingDir = mkdtempSync(join(tmpdir(), 'apple-docs-render-font-'))
  const scriptPath = join(stagingDir, 'render-font.swift')
  await Bun.write(scriptPath, FONT_TEXT_SCRIPT)
  try {
    const { stdout, stderr, exitCode } = await spawnWithDeadline(
      ['swift', scriptPath, fontPath, text, String(pointSize)],
      { deadlineMs: 10_000 },
    )
    if (exitCode !== 0) throw new ValidationError(stderr.trim() || `swift exited ${exitCode}`)
    return new TextDecoder().decode(stdout)
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}
