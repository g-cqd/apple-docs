/**
 * Public render endpoints (SF Symbols, font text samples) sit on a CPU
 * budget that's the project's only constrained resource — every render
 * spawns Swift. The endpoints stay publicly reachable but bound the
 * work per request: hard text length cap, parameter allowlists with
 * explicit rejection (no silent clamp-and-render fallback).
 */

import { SYMBOL_WEIGHTS, SYMBOL_SCALES } from '../../resources/apple-assets.js'

export const FONT_TEXT_MAX_CHARS = 256

/** Sizes the SF Symbol renderer is willing to accept. Discrete to keep the
 * persistent render cache from growing unboundedly with attacker-chosen
 * parameter combinations. 256 is the canonical "download a single symbol
 * at high resolution" size and is emitted by the symbols-page detail
 * panel's download links; smaller sizes serve the grid/inspector
 * previews. */
export const ALLOWED_SYMBOL_SIZES = new Set([8, 12, 16, 20, 24, 32, 48, 64, 96, 128, 256])

const COLOR_RE = /^#?[0-9A-Fa-f]{6}$/

function fail(error) {
  return { ok: false, error }
}

function ok(value) {
  return { ok: true, value }
}

/**
 * Validate the `?text=` query string for `/api/fonts/text.svg`.
 *
 * @param {string | null | undefined} text
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validateFontText(text) {
  if (text == null || text === '') return ok('Typography')
  if (typeof text !== 'string') return fail('text must be a string')
  if (text.length > FONT_TEXT_MAX_CHARS) {
    return fail(`text exceeds ${FONT_TEXT_MAX_CHARS} chars (got ${text.length})`)
  }
  return ok(text)
}

/**
 * Validate a symbol-render parameter bundle. Each missing param resolves to
 * undefined (caller falls through to the renderer's own default). Each
 * present-but-invalid param yields a 400-shaped error — no silent fallback.
 *
 * @param {{ size?: string|null, color?: string|null, background?: string|null, weight?: string|null, scale?: string|null }} params
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateSymbolParams(params) {
  const out = {}

  if (params.size != null && params.size !== '') {
    const n = Number.parseInt(String(params.size), 10)
    if (!Number.isFinite(n) || !ALLOWED_SYMBOL_SIZES.has(n)) {
      const allowed = Array.from(ALLOWED_SYMBOL_SIZES).join(', ')
      return fail(`size must be one of: ${allowed}`)
    }
    out.size = String(n)
  }

  if (params.color != null && params.color !== '') {
    if (!COLOR_RE.test(String(params.color))) {
      return fail('color must be a 6-character hex value (e.g. #FF8800 or FF8800)')
    }
    out.color = String(params.color)
  }

  if (params.background != null && params.background !== '') {
    if (!COLOR_RE.test(String(params.background))) {
      return fail('bg must be a 6-character hex value (e.g. #FF8800 or FF8800)')
    }
    out.background = String(params.background)
  }

  if (params.weight != null && params.weight !== '') {
    const w = String(params.weight).toLowerCase()
    if (!SYMBOL_WEIGHTS.includes(w)) {
      return fail(`weight must be one of: ${SYMBOL_WEIGHTS.join(', ')}`)
    }
    out.weight = w
  }

  if (params.scale != null && params.scale !== '') {
    const s = String(params.scale).toLowerCase()
    if (!SYMBOL_SCALES.includes(s)) {
      return fail(`scale must be one of: ${SYMBOL_SCALES.join(', ')}`)
    }
    out.scale = s
  }

  return ok(out)
}
