/**
 * v24 — tag each stamped codepoint with the SF Symbols version it was resolved
 * from (`sf_symbols.codepoint_version`, nullable TEXT, e.g. "8.0").
 *
 * SF Symbols PUA codepoints are tied to a specific SFSymbolsFallback.otf: a
 * given symbol can move to a different codepoint across major releases. The
 * snapshot ships exactly one font version, so recording which version a
 * codepoint came from makes the mapping self-describing and lets a consumer
 * match the shipped font to its codepoints (and detect drift on the next sync).
 * ALTER guarded against re-run on partial DBs.
 */
export function up(db) {
  try {
    db.run('ALTER TABLE sf_symbols ADD COLUMN codepoint_version TEXT')
  } catch {
    /* column already exists */
  }
}
