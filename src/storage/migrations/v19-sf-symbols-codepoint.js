/**
 * v19 — `sf_symbols.codepoint` (nullable INTEGER) stamped at snapshot
 * sync time from the SF Symbols framework / SF-Pro.ttf via a Swift
 * helper. NULL means "unknown" (the symbol exists in the catalog but
 * isn't drawn by SF-Pro, or the font wasn't available when the
 * snapshot was built); a non-NULL value is the Private Use Area
 * codepoint the runtime would feed into a Text("\u{XXXX}") render.
 *
 * Partial index `idx_sf_symbols_codepoint` only covers non-NULL rows
 * so it stays small while still letting a `codepoint -> name`
 * reverse-lookup endpoint hit it (subset endpoint planned for P3).
 */
export function up(db) {
  try {
    db.run('ALTER TABLE sf_symbols ADD COLUMN codepoint INTEGER')
  } catch (e) {
    // Idempotent re-run.
    if (!/duplicate column name/i.test(e.message ?? '')) throw e
  }
  db.run(
    'CREATE INDEX IF NOT EXISTS idx_sf_symbols_codepoint ON sf_symbols(codepoint) WHERE codepoint IS NOT NULL',
  )
}
