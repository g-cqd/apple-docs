// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * The catalog is sourced from the current SF Symbols.app release, which
 * can be newer than the building macOS (SF Symbols 8.2 lists
 * macOS-27-era names like private/f1). CoreGlyphs on an older OS has no
 * glyph for those, so EVERY variant fails. Flag such symbols
 * (v27 `render_unsupported`) so the snapshot completeness gate skips
 * them — partial failures stay loud and still fail the gate.
 */
export function markUnrenderableSymbols({ ctx, scope, variants, result, logger }) {
  const failedBySymbol = new Map()
  for (const f of result.failures) {
    if (f.scope !== scope) continue
    failedBySymbol.set(f.name, (failedBySymbol.get(f.name) ?? 0) + 1)
  }
  const unsupported = []
  for (const [name, count] of failedBySymbol) {
    if (count < variants.length) continue
    try {
      ctx.db.assetsSymbols.markRenderUnsupported(scope, name)
      unsupported.push(name)
    } catch {}
  }
  if (unsupported.length > 0) {
    logger?.warn?.(
      `${unsupported.length} ${scope} symbol(s) unrenderable on this macOS ` +
        `(catalog newer than OS): ${unsupported.slice(0, 8).join(', ')}${unsupported.length > 8 ? ', …' : ''}`,
    )
  }
}
