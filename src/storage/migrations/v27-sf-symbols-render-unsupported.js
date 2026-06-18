// @ts-nocheck -- checkJs burndown: pending JSDoc typing (remove when this file type-checks)
/**
 * v27 — `sf_symbols.render_unsupported` flag for symbols the build
 * host's macOS cannot draw.
 *
 * The symbols catalog is sourced from the current SF Symbols.app
 * release, which can be newer than the building OS (SF Symbols 8.2
 * lists macOS-27-era names like `private/f1`); CoreGlyphs on an older
 * macOS has no glyph for them, so every prerender variant fails and
 * the snapshot completeness gate (validate.js) hard-failed the build.
 * Mirrors the v18 `bitmap_only` pattern: the prerender loop marks the
 * row when ALL variants fail, the validator skips flagged rows, and
 * the render surfaces explain that the symbol needs a snapshot built
 * on a newer macOS (the beta channel).
 */
export function up(db) {
  try {
    db.run('ALTER TABLE sf_symbols ADD COLUMN render_unsupported INTEGER NOT NULL DEFAULT 0')
  } catch (e) {
    // Idempotent re-run.
    if (!/duplicate column name/i.test(e.message ?? '')) throw e
  }
}
