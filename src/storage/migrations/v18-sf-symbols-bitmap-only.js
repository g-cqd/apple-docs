/**
 * v18 — `sf_symbols.bitmap_only` flag for symbols whose private bundle
 * representation is bitmap-backed (emoji.*, year_to_release, etc.).
 *
 * The Swift symbol-worker fix (commit f6cc71a) made the prerender
 * loop tolerate symbols that don't implement `-vectorGlyph`. The
 * remaining gap was that `validate.js` still flagged those variants
 * as missing on disk, which blocked snapshot builds. Adding the flag
 * here lets the catalog ingest mark them at sync time and the
 * validator skip them, while still keeping the symbol visible to
 * `/api/symbols/search` for clients that can render a fallback.
 */
export function up(db) {
  try {
    db.run('ALTER TABLE sf_symbols ADD COLUMN bitmap_only INTEGER NOT NULL DEFAULT 0')
  } catch (e) {
    // Idempotent re-run.
    if (!/duplicate column name/i.test(e.message ?? '')) throw e
  }
}
