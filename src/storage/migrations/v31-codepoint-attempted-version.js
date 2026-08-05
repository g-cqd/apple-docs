/**
 * v31 — `sf_symbols.codepoint_attempted_version`.
 *
 * The public symbol catalog comes from the RUNNING macOS (CoreGlyphs), while
 * codepoints are resolved against the released SF Symbols.app font — which
 * lags the OS (e.g. macOS 26.6 ships catalog names that SF Symbols.app 8.0
 * cannot resolve). Those rows are not errors and not permanently
 * unresolvable: they resolve once a newer app releases. Recording the app
 * version each failed resolution was attempted against lets the stamp skip
 * them while the installed app is unchanged, and automatically retry when a
 * newer app version is provisioned (or on `--full`).
 */
export function up(db) {
  try {
    db.run('ALTER TABLE sf_symbols ADD COLUMN codepoint_attempted_version TEXT')
  } catch { /* re-run */ }
}
