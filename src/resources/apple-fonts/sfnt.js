/**
 * SFNT (TrueType / OpenType) header inspection + filename parsing.
 *
 * Shared by the font-discovery and font-render paths so neither needs
 * to pull in the full Bun.spawn / DMG-extract surface.
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { basename, extname } from 'node:path'

// Apple's typography ships with a fixed vocabulary for both axes. Order
// matters for weight rendering (Ultralight → Black) — the UI uses these
// arrays directly to lay pills out in design order.
const FONT_VARIANTS = ['Display', 'Text', 'Rounded', 'ExtraLarge', 'Large', 'Medium', 'Small']
const FONT_WEIGHTS = ['Ultralight', 'Thin', 'Light', 'Regular', 'Medium', 'Semibold', 'Bold', 'Heavy', 'Black']

const VARIANT_LOOKUP = new Map(FONT_VARIANTS.map(v => [v.toLowerCase(), v]))
const WEIGHT_LOOKUP = new Map(FONT_WEIGHTS.map(w => [w.toLowerCase(), w]))

/**
 * Cheap magic-byte check for an SFNT-like font file. CoreText behaviour on a
 * non-SFNT file is "undefined" in practice — observed to either segfault,
 * register a phantom descriptor, or stall indefinitely on macOS CI runners.
 * Probing the header up-front lets corrupt fixtures short-circuit straight
 * to a placeholder render path without spawning Swift.
 *
 * @param {string} path
 * @returns {Promise<boolean>}
 */
export async function isLikelySfnt(path) {
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(4)
      const read = readSync(fd, buf, 0, 4, 0)
      if (read < 4) return false
      const tag = buf.toString('ascii')
      if (tag === 'OTTO' || tag === 'ttcf' || tag === 'wOFF' || tag === 'wOF2') return true
      return buf[0] === 0x00 && buf[1] === 0x01 && buf[2] === 0x00 && buf[3] === 0x00
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

export function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return [value]
  return []
}

/**
 * Parse an Apple font file name into structured fields.
 * Examples:
 *   SF-Pro-Display-BoldItalic.otf  → { variant: 'Display', weight: 'Bold', italic: true }
 *   SF-Pro-Italic.ttf              → { variant: null, weight: null, italic: true }
 *   NewYorkSmall-RegularItalic.otf → { variant: 'Small', weight: 'Regular', italic: true }
 *   SF-Mono-Bold.otf               → { variant: null, weight: 'Bold', italic: false }
 *   SF-Pro.ttf                     → { variant: null, weight: null, italic: false }
 */
export function parseFontFilename(fileName) {
  const stem = basename(fileName, extname(fileName))
  // Tail token: weight or weightItalic (after the last dash, or no dash).
  const dashIndex = stem.lastIndexOf('-')
  const tail = dashIndex === -1 ? stem : stem.slice(dashIndex + 1)
  let italic = false
  let weight = null
  let trailingWeightToken = ''

  // Try to peel "Italic" off the right side of the trailing token first.
  if (/Italic$/i.test(tail)) {
    italic = true
    trailingWeightToken = tail.slice(0, -'Italic'.length)
  } else {
    trailingWeightToken = tail
  }
  if (trailingWeightToken) {
    weight = WEIGHT_LOOKUP.get(trailingWeightToken.toLowerCase()) ?? null
  }

  // Variant is the second-to-last token (or attached to the head: NewYorkSmall).
  let variant = null
  if (weight !== null && dashIndex !== -1) {
    const head = stem.slice(0, dashIndex)
    const headTail = head.slice(head.lastIndexOf('-') + 1)
    variant = VARIANT_LOOKUP.get(headTail.toLowerCase()) ?? null
    if (variant === null) {
      // Variant may be glued to the family prefix, e.g. NewYorkSmall.
      for (const candidate of FONT_VARIANTS) {
        if (head.toLowerCase().endsWith(candidate.toLowerCase())) {
          variant = candidate
          break
        }
      }
    }
  } else if (weight === null && italic === false) {
    // Bare files like NewYork.ttf, SF-Pro.ttf — no weight token, no variant.
    variant = null
  } else {
    // Italic-only files like SF-Pro-Italic.ttf — no variant.
    variant = null
  }

  return { variant, weight, italic }
}

/**
 * Read the OpenType/TrueType table directory of a font file and report
 * variability. Returns `{ isVariable, axes }` — `axes` is empty for static
 * fonts and an array of `{ tag, min, default, max }` entries for variable
 * fonts. Best-effort: any parse error returns the static defaults.
 */
export function inspectSfntFile(filePath) {
  try {
    const buffer = readSfntHeader(filePath)
    if (!buffer) return { isVariable: false, axes: [] }
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const numTables = view.getUint16(4)
    if (numTables === 0 || numTables > 256) return { isVariable: false, axes: [] }
    let fvarOffset = -1
    let fvarLength = 0
    for (let i = 0; i < numTables; i++) {
      const entry = 12 + i * 16
      if (entry + 16 > view.byteLength) break
      const tag = String.fromCharCode(
        view.getUint8(entry),
        view.getUint8(entry + 1),
        view.getUint8(entry + 2),
        view.getUint8(entry + 3),
      )
      if (tag === 'fvar') {
        fvarOffset = view.getUint32(entry + 8)
        fvarLength = view.getUint32(entry + 12)
        break
      }
    }
    if (fvarOffset < 0) return { isVariable: false, axes: [] }
    const fvar = readBytes(filePath, fvarOffset, fvarLength)
    if (!fvar) return { isVariable: false, axes: [] }
    const fvarView = new DataView(fvar.buffer, fvar.byteOffset, fvar.byteLength)
    const offsetToAxes = fvarView.getUint16(4)
    const axisCount = fvarView.getUint16(8)
    const axisSize = fvarView.getUint16(10)
    if (axisCount === 0 || axisSize < 20) return { isVariable: true, axes: [] }
    const axes = []
    for (let i = 0; i < axisCount; i++) {
      const start = offsetToAxes + i * axisSize
      if (start + 20 > fvarView.byteLength) break
      const tag = String.fromCharCode(
        fvarView.getUint8(start),
        fvarView.getUint8(start + 1),
        fvarView.getUint8(start + 2),
        fvarView.getUint8(start + 3),
      )
      const min = fvarView.getInt32(start + 4) / 65536
      const def = fvarView.getInt32(start + 8) / 65536
      const max = fvarView.getInt32(start + 12) / 65536
      axes.push({ tag, min, default: def, max })
    }
    return { isVariable: true, axes }
  } catch {
    return { isVariable: false, axes: [] }
  }
}

function readSfntHeader(filePath) {
  // Need at least 12 bytes (offset table) + numTables × 16. 16 KB is plenty
  // for any real font's directory and avoids reading the whole file just to
  // peek at the header.
  const head = readBytes(filePath, 0, 12)
  if (!head) return null
  const headView = new DataView(head.buffer, head.byteOffset, head.byteLength)
  const scaler = headView.getUint32(0)
  // Reject TrueType collections (`ttcf` = 0x74746366) — they wrap multiple
  // sfnt fonts and need a different walk; the variable detection isn't
  // worth the complexity for our corpus (Apple ships static .ttc only).
  if (scaler === 0x74746366) return null
  const numTables = headView.getUint16(4)
  return readBytes(filePath, 0, 12 + numTables * 16)
}

function readBytes(filePath, offset, length) {
  if (length <= 0) return null
  const buffer = Buffer.alloc(length)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buffer, 0, length, offset)
    return buffer
  } finally {
    closeSync(fd)
  }
}
