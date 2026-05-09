/**
 * Font preview renderer.
 *
 * Spawns Swift+CoreText to lay out the user's text in the requested font and
 * walks every glyph's path into a theme-neutral SVG. The Swift script lives
 * verbatim in resources/swift-templates.js so this module stays small and
 * the script body can be diffed independently.
 *
 * Pulled out of resources/apple-assets.js as part of P3.7.
 */

import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clampInteger,
  escapeXml,
  tempSuffix,
} from '../apple-assets-helpers.js'
import { isLikelySfnt } from './sfnt.js'
import { FONT_TEXT_SCRIPT } from '../swift-templates.js'

export async function renderFontText(opts, ctx) {
  const font = ctx.db.getAppleFontFile(opts.fontId)
  if (!font) throw new Error(`Font file not found: ${opts.fontId}`)
  const text = String(opts.text ?? 'Typography')
  const pointSize = clampInteger(opts.size ?? 96, 8, 512)
  let content
  // CoreText / CTFontManagerRegisterFontsForURL behaviour on a non-SFNT
  // file is "undefined" in practice — observed to either segfault, register
  // a phantom descriptor, or stall indefinitely on macOS CI runners (the
  // last case wedges the request handler and the server eventually drops
  // listening for the test fetch). Probe the magic header up-front so test
  // fixtures and corrupt downloads short-circuit straight to the placeholder
  // SVG without spawning Swift.
  const valid = await isLikelySfnt(font.file_path)
  if (!valid) {
    content = renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize })
  } else {
    try {
      content = await renderFontTextSvgCurves({ fontPath: font.file_path, text, pointSize })
    } catch (error) {
      ctx.logger?.warn?.(`CoreText outline render failed for ${font.file_name}: ${error.message}`)
      content = renderFontTextSvgFallback({ fontFamily: font.family_display_name, text, pointSize })
    }
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

async function renderFontTextSvgCurves({ fontPath, text, pointSize }) {
  const scriptPath = join(tmpdir(), `apple-docs-render-font-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, FONT_TEXT_SCRIPT)
  try {
    const proc = Bun.spawn(['swift', scriptPath, fontPath, text, String(pointSize)], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) throw new Error(stderr.trim() || `swift exited ${code}`)
    return stdout
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}
