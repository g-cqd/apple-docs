/**
 * SF Symbols cache-key + variant matrix.
 *
 * Pre-rendered symbol SVGs live on disk under
 *   <dataDir>/resources/symbols/<scope>/<weight>-<scale>/<name>.svg
 * (with the regular/medium variant kept at the scope root for backwards
 * compatibility with earlier snapshots that didn't carry the variant axis).
 *
 * Shared by the render path, the snapshot pre-renderer, and the
 * route-side validators so they all use the same normalization.
 */

import { join } from 'node:path'
import { sanitizeFileName } from '../apple-assets-helpers.js'

export const SYMBOL_WEIGHTS = ['ultralight', 'thin', 'light', 'regular', 'medium', 'semibold', 'bold', 'heavy', 'black']
export const SYMBOL_SCALES = ['small', 'medium', 'large']

export function normalizeSymbolWeight(value) {
  const weight = String(value ?? '').toLowerCase()
  return SYMBOL_WEIGHTS.includes(weight) ? weight : 'regular'
}

export function normalizeSymbolScale(value) {
  const scale = String(value ?? '').toLowerCase()
  return SYMBOL_SCALES.includes(scale) ? scale : 'medium'
}

/**
 * Cartesian product of weight × scale used to drive snapshot pre-rendering.
 * Private symbols are scope-locked to the regular/medium variant — Apple's
 * private SF Symbols framework intentionally ships one rendering only.
 */
export function symbolVariantMatrix(scope) {
  if (scope === 'private') return [{ weight: 'regular', scale: 'medium' }]
  const variants = []
  for (const weight of SYMBOL_WEIGHTS) {
    for (const scale of SYMBOL_SCALES) variants.push({ weight, scale })
  }
  return variants
}

export function symbolVariantKey(variant) {
  return `${normalizeSymbolWeight(variant?.weight)}/${normalizeSymbolScale(variant?.scale)}`
}

/**
 * Resolve the on-disk path for a pre-rendered symbol SVG.
 * @param {{ dataDir: string }} ctx
 * @param {'public'|'private'} scope
 * @param {string} name
 * @param {{ weight?: string, scale?: string }} [opts]
 */
export function getPrerenderedSymbolPath(ctx, scope, name, opts = {}) {
  const cleanScope = scope === 'private' ? 'private' : 'public'
  const weight = normalizeSymbolWeight(opts.weight)
  const scale = normalizeSymbolScale(opts.scale)
  if (cleanScope === 'public' && (weight !== 'regular' || scale !== 'medium')) {
    return join(ctx.dataDir, 'resources', 'symbols', cleanScope, `${weight}-${scale}`, `${sanitizeFileName(name)}.svg`)
  }
  return join(ctx.dataDir, 'resources', 'symbols', cleanScope, `${sanitizeFileName(name)}.svg`)
}
