/**
 * SVG post-processing helpers for SF Symbol rendering.
 *
 * All pure string transforms — no filesystem, no spawn — so they're
 * trivially testable in isolation.
 *
 * The pre-rendered snapshot SVGs ship with `width`/`height` set to Apple's
 * source point size and a single `fill="#000000"` per visible layer. At
 * request time we rewrite the dimensions to the caller's pointSize, swap
 * the visible-black fill for the requested color (preserving any internal
 * `<mask>` cut-outs that themselves use #000000), and optionally inject a
 * background `<rect>` sized off the SVG's viewBox.
 */

import { escapeXml } from '../apple-assets-helpers.js'

export function renderSymbolSvgFallback(/** @type {any} */ { name, scope, pointSize, color, background }) {
  const escapedName = escapeXml(name)
  const escapedColor = escapeXml(color)
  const escapedScope = escapeXml(scope)
  const bgRect = background ? `<rect width="100%" height="100%" fill="${escapeXml(background)}"/>` : `<rect width="100%" height="100%" fill="none"/>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pointSize}" height="${pointSize}" viewBox="0 0 ${pointSize} ${pointSize}" role="img" aria-label="${escapedName}">
  <title>${escapedName}</title>
  <metadata>apple-docs ${escapedScope} SF Symbol placeholder; request PNG for AppKit-rendered symbol raster.</metadata>
  ${bgRect}
  <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle" font-family="SF Pro, -apple-system, BlinkMacSystemFont, sans-serif" font-size="${Math.max(8, pointSize / 7)}" fill="${escapedColor}">${escapedName}</text>
</svg>`
}

export function customizePrerenderedSymbolSvg(/** @type {any} */ svg, /** @type {any} */ { pointSize, color, background }) {
  let output = setSvgDimensionAttributes(String(svg), pointSize)
  output = replaceVisibleBlackFill(output, color)
  if (background) output = insertSvgBackground(output, background)
  return output
}

function setSvgDimensionAttributes(/** @type {any} */ svg, /** @type {any} */ pointSize) {
  return svg.replace(/<svg\b([^>]*)>/i, (/** @type {any} */ _match, /** @type {any} */ attrs) => {
    let nextAttrs = upsertSvgAttribute(attrs, 'width', pointSize)
    nextAttrs = upsertSvgAttribute(nextAttrs, 'height', pointSize)
    return `<svg${nextAttrs}>`
  })
}

function upsertSvgAttribute(/** @type {any} */ attrs, /** @type {any} */ name, /** @type {any} */ value) {
  const escapedValue = escapeXml(value)
  const attrRe = new RegExp(`\\s${name}=(["'])[^"']*\\1`, 'i')
  if (attrRe.test(attrs)) {
    return attrs.replace(attrRe, ` ${name}="${escapedValue}"`)
  }
  return `${attrs} ${name}="${escapedValue}"`
}

function replaceVisibleBlackFill(/** @type {any} */ svg, /** @type {any} */ color) {
  const escapedColor = escapeXml(color)
  const replaceFill = (/** @type {any} */ chunk) =>
    chunk.replace(/\bfill=(["'])#000000\1/gi, (/** @type {any} */ _match, /** @type {any} */ quote) => `fill=${quote}${escapedColor}${quote}`)
  const maskRe = /<mask\b[\s\S]*?<\/mask>/gi
  let output = ''
  let cursor = 0
  for (const match of svg.matchAll(maskRe)) {
    output += replaceFill(svg.slice(cursor, match.index))
    output += match[0]
    cursor = match.index + match[0].length
  }
  output += replaceFill(svg.slice(cursor))
  return output
}

function insertSvgBackground(/** @type {any} */ svg, /** @type {any} */ background) {
  const rect = svgBackgroundRect(svg, background)
  if (/<defs[\s>]/i.test(svg) && /<\/defs>/i.test(svg)) {
    return svg.replace(/<\/defs>/i, `</defs>\n  ${rect}`)
  }
  return svg.replace(/<svg\b[^>]*>/i, (/** @type {any} */ match) => `${match}\n  ${rect}`)
}

function svgBackgroundRect(/** @type {any} */ svg, /** @type {any} */ background) {
  const box = parseSvgViewBox(svg) ?? { x: 0, y: 0, width: 100, height: 100 }
  return `<rect x="${formatSvgNumber(box.x)}" y="${formatSvgNumber(box.y)}" width="${formatSvgNumber(box.width)}" height="${formatSvgNumber(box.height)}" fill="${escapeXml(background)}"/>`
}

function parseSvgViewBox(/** @type {any} */ svg) {
  const match = svg.match(/\bviewBox=(["'])([^"']+)\1/i)
  if (!match) return null
  const parts = match[2]
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  if (parts.length !== 4 || parts.some((/** @type {any} */ value) => !Number.isFinite(value))) return null
  return { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
}

function formatSvgNumber(/** @type {any} */ value) {
  return Number(value)
    .toFixed(3)
    .replace(/\.?0+$/u, '')
}
