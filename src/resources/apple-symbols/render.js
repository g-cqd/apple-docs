/**
 * SF Symbol render pipeline (SVG + PNG).
 *
 * Public entry: renderSfSymbol — checks the per-render DB cache first,
 * then walks: snapshot SVG → live SVG (via PDF) → PNG raster → fallback
 * placeholder. Each stage is its own helper so a failure at any layer
 * falls forward without dragging the others down.
 *
 * Pulled out of resources/apple-assets.js as part of P3.7.
 */

import { existsSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256 } from '../../lib/hash.js'
import { spawnWithDeadline } from '../../lib/spawn-with-deadline.js'
import { ensureDir } from '../../storage/files.js'
import {
  clampInteger,
  normalizeBackground,
  normalizeColor,
  sanitizeFileName,
  tempSuffix,
} from '../apple-assets-helpers.js'
import {
  getPrerenderedSymbolPath,
  normalizeSymbolScale,
  normalizeSymbolWeight,
} from './cache-key.js'
import {
  customizePrerenderedSymbolSvg,
  renderSymbolSvgFallback,
} from './svg-helpers.js'
import { symbolPdfToSvg } from '../symbol-pdf-to-svg.js'
import {
  SYMBOL_PDF_SCRIPT,
  SYMBOL_PNG_SCRIPT,
} from '../swift-templates.js'

// Bumping `renderer` invalidates every cached SVG/PNG so the next request
// refreshes against the current snapshot/live renderer contract.
//   - 2: tried `_vectorGlyph` without flip + forced evenodd (broke many)
//   - 3: switched to `outlinePath` (single flat path; loses per-layer
//        XOR/exclusion → tray.badge.sparkles renders as a blob)
//   - 4: canonical pipeline — vectorGlyph.drawInContext: into a 2048pt
//        PDF page, then pdftocairo → SVG, then strip the clipPath
//        wrapper and recompute viewBox from path data. Lost cut-out
//        layers on .fill symbols (xmark.bin.circle.fill, health.fill).
//   - 5: same Swift PDF emitter, but parse the PDF in JS and convert
//        `/ca 0` ExtGState fills into SVG `<mask>` cut-outs. True
//        vector fidelity for every layer-cutout symbol.
//   - 6: weight + scale plumbed through to NSSymbolConfiguration so
//        the inspector controls actually re-render the preview.
//   - 7: alpha-zero cut layers now emit fill-rule-preserving internal
//        SVG masks instead of the old even-odd clip subtraction shortcut.
//   - 8: runtime renders derive from snapshot SVG geometry first; live
//        CoreGlyphs/AppKit rendering is fallback only.
export const SYMBOL_RENDERER_VERSION = 8

export async function renderSfSymbol(opts, ctx) {
  const scope = opts.scope === 'private' ? 'private' : 'public'
  const format = opts.format === 'svg' ? 'svg' : 'png'
  const pointSize = clampInteger(opts.size ?? opts.pointSize ?? 64, 8, 1024)
  const requestedWeight = normalizeSymbolWeight(opts.weight)
  const requestedScale = normalizeSymbolScale(opts.scale)
  const weight = scope === 'public' ? requestedWeight : 'regular'
  const scale = scope === 'public' ? requestedScale : 'medium'
  // SVG accepts the literal string "currentColor" so it inherits the page's
  // CSS color. PNG cannot — Apple's renderer needs a concrete sRGB value, so
  // we fall back to black for PNG when "currentColor" is requested.
  const rawColor = opts.color ?? '#000000'
  const color = format === 'svg' && String(rawColor).toLowerCase() === 'currentcolor'
    ? 'currentColor'
    : normalizeColor(rawColor)
  const background = normalizeBackground(opts.background ?? opts.bg)
  const cacheKey = sha256(JSON.stringify({
    renderer: SYMBOL_RENDERER_VERSION,
    type: 'sf-symbol',
    scope,
    name: opts.name,
    format,
    pointSize,
    weight,
    scale,
    color,
    background,
  })).slice(0, 32)
  const cached = ctx.db.getSfSymbolRender(cacheKey)
  if (cached && existsSync(cached.file_path)) return cached

  const symbol = ctx.db.getSfSymbol(scope, opts.name)
  if (!symbol) throw new Error(`SF Symbol not found: ${scope}/${opts.name}`)

  const renderDir = join(ctx.dataDir, 'resources', 'symbol-renders', scope)
  ensureDir(renderDir)
  const filePath = join(renderDir, `${sanitizeFileName(opts.name)}.${cacheKey}.${format}`)
  let data
  let mode = 'live'
  const snapshotSvg = await renderSymbolSvgFromSnapshot({
    name: opts.name, scope, pointSize, weight, scale, color, background,
  }, ctx)
  if (snapshotSvg) {
    if (format === 'svg') {
      data = snapshotSvg
      mode = 'snapshot'
    } else {
      try {
        data = await renderPngFromSvg(snapshotSvg, { pointSize })
        mode = 'snapshot'
      } catch (error) {
        ctx.logger?.warn?.(`SF Symbol snapshot PNG rasterization failed for ${scope}/${opts.name}: ${error.message}`)
      }
    }
  }
  if (!data) {
    if (format === 'svg') {
      try {
        data = await renderSymbolSvgCurves({ name: opts.name, scope, pointSize, weight, scale, color, background })
      } catch (error) {
        ctx.logger?.warn?.(`SF Symbol SVG outline render failed for ${scope}/${opts.name}: ${error.message}`)
        data = renderSymbolSvgFallback({ name: opts.name, scope, pointSize, color, background })
      }
    } else {
      data = await renderSymbolPng({ name: opts.name, scope, pointSize, weight, scale, color, background })
    }
  }
  await Bun.write(filePath, data)
  const bytes = await Bun.file(filePath).arrayBuffer()
  const row = {
    cacheKey,
    name: opts.name,
    scope,
    format,
    mode,
    weight,
    symbolScale: scale,
    pointSize,
    color,
    filePath,
    mimeType: format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png',
    sha256: sha256(bytes),
    size: bytes.byteLength,
  }
  ctx.db.upsertSfSymbolRender(row)
  return ctx.db.getSfSymbolRender(cacheKey)
}

async function renderSymbolPng({ name, scope, pointSize, weight = 'regular', scale = 'medium', color, background }) {
  const scriptPath = join(tmpdir(), `apple-docs-render-symbol-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, SYMBOL_PNG_SCRIPT)
  try {
    const { stdout, stderr, exitCode } = await spawnWithDeadline(
      ['swift', scriptPath, name, scope, String(pointSize), color, background ?? '', weight, scale],
      { deadlineMs: 10_000 },
    )
    if (exitCode !== 0) throw new Error(stderr.trim() || `swift exited ${exitCode}`)
    return stdout
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}

async function renderSymbolSvgCurves({ name, scope, pointSize, weight = 'regular', scale = 'medium', color, background }) {
  const pdfBytes = await renderSymbolToPdfBytes({ name, scope, weight, scale })
  return symbolPdfToSvg(pdfBytes, { name, pointSize, color, background })
}

async function renderSymbolToPdfBytes({ name, scope, weight = 'regular', scale = 'medium' }) {
  const scriptPath = join(tmpdir(), `apple-docs-symbol-pdf-${process.pid}-${tempSuffix()}.swift`)
  await Bun.write(scriptPath, SYMBOL_PDF_SCRIPT)
  try {
    const { stdout, stderr, exitCode } = await spawnWithDeadline(
      ['swift', scriptPath, name, scope, weight, scale],
      { deadlineMs: 10_000 },
    )
    if (exitCode !== 0) throw new Error(stderr.trim() || `swift exited ${exitCode}`)
    return new Uint8Array(stdout)
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}

async function renderSymbolSvgFromSnapshot({ name, scope, pointSize, weight, scale, color, background }, ctx) {
  const filePath = getPrerenderedSymbolPath(ctx, scope, name, { weight, scale })
  const file = Bun.file(filePath)
  if (!await file.exists()) return null
  try {
    const svg = await file.text()
    return customizePrerenderedSymbolSvg(svg, { pointSize, color, background })
  } catch (error) {
    ctx.logger?.warn?.(`SF Symbol snapshot SVG read failed for ${scope}/${name}: ${error.message}`)
    return null
  }
}

async function renderPngFromSvg(svg, { pointSize }) {
  const dir = await mkdtemp(join(tmpdir(), 'apple-docs-symbol-snapshot-'))
  const svgPath = join(dir, 'symbol.svg')
  const pngPath = join(dir, 'symbol.png')
  const errors = []
  try {
    await Bun.write(svgPath, svg)
    const rsvg = await runRasterCommand(['rsvg-convert', '-w', String(pointSize), '-h', String(pointSize), svgPath, '-o', pngPath])
    if (rsvg.ok) return await readRasterizedPng(pngPath)
    errors.push(`rsvg-convert: ${rsvg.error}`)

    await rm(pngPath, { force: true }).catch(() => {})
    const sips = await runRasterCommand(['/usr/bin/sips', '-s', 'format', 'png', svgPath, '--out', pngPath])
    if (sips.ok) return await readRasterizedPng(pngPath)
    errors.push(`sips: ${sips.error}`)

    throw new Error(errors.join('; '))
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readRasterizedPng(path) {
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error('rasterizer did not produce a PNG')
  }
  return await Bun.file(path).arrayBuffer()
}

async function runRasterCommand(args) {
  try {
    const { stdout, stderr, exitCode } = await spawnWithDeadline(args, { deadlineMs: 10_000 })
    if (exitCode !== 0) {
      const stdoutText = new TextDecoder().decode(stdout).trim()
      return { ok: false, error: stderr.trim() || stdoutText || `exited ${exitCode}` }
    }
    return { ok: true, error: null }
  } catch (error) {
    return { ok: false, error: error.message }
  }
}
