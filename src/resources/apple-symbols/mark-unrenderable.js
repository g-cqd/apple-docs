/**
 * The catalog is sourced from the current SF Symbols.app release, which
 * can be newer than the building macOS (SF Symbols 8.2 lists
 * macOS-27-era names like private/f1). CoreGlyphs on an older OS has no
 * glyph for those, so EVERY variant fails. Flag such symbols
 * (v27 `render_unsupported`) so the snapshot completeness gate skips
 * them.
 *
 * A host can also draw a symbol at only SOME variants — macos-26 renders
 * `public/square.and.arrow.up` at every weight except ultralight
 * (small/medium/large) and thin/small. Those used to be left unflagged on the
 * theory that a partial failure is a bug worth blocking on, but the gate then
 * counted them as permanently-missing pre-renders and no snapshot could ever
 * build. So record the exact failing set instead (v28
 * `unsupported_variants`): the validator skips those variants and still flags
 * anything else, so a genuine regression stays loud.
 */
export function markUnrenderableSymbols({ ctx, scope, variants, result, logger }) {
  /** @type {Map<string, string[]>} */
  const failedBySymbol = new Map()
  for (const f of result.failures) {
    if (f.scope !== scope) continue
    const list = failedBySymbol.get(f.name) ?? []
    // The variant is what distinguishes a partial failure from a total one;
    // a failure without one can only be counted, not attributed.
    if (f.weight && f.scale) list.push(`${f.weight}/${f.scale}`)
    failedBySymbol.set(f.name, list)
  }

  const unsupported = []
  const partial = []
  for (const [name, failedVariants] of failedBySymbol) {
    const total = failedVariants.length
    try {
      if (total >= variants.length) {
        // No drawable variant at all — the v27 whole-symbol flag.
        ctx.db.assetsSymbols.markRenderUnsupported(scope, name)
        unsupported.push(name)
      } else if (total > 0) {
        ctx.db.assetsSymbols.setUnsupportedVariants?.(scope, name, failedVariants)
        partial.push(`${name} (${failedVariants.join(', ')})`)
      }
    } catch {}
  }

  if (unsupported.length > 0) {
    logger?.warn?.(
      `${unsupported.length} ${scope} symbol(s) unrenderable on this macOS ` +
      `(catalog newer than OS): ${unsupported.slice(0, 8).join(', ')}${unsupported.length > 8 ? ', …' : ''}`,
    )
  }
  if (partial.length > 0) {
    logger?.warn?.(
      `${partial.length} ${scope} symbol(s) unrenderable at SOME variants on this macOS: ` +
        `${partial.slice(0, 8).join('; ')}${partial.length > 8 ? '; …' : ''}`,
    )
  }
}
