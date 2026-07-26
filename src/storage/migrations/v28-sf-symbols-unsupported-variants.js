/**
 * v28 — `sf_symbols.unsupported_variants` for symbols the build host's
 * macOS can draw only at SOME (weight × scale) variants.
 *
 * v27 made "unrenderable" all-or-nothing: the prerender loop flags a row
 * only when EVERY variant fails, on the theory that a partial failure is a
 * real bug and should stay loud. Reality disagreed — on macos-26,
 * `public/square.and.arrow.up` draws at every weight except ultralight
 * (small/medium/large) and thin/small: 4 of its variants, the rest fine. No
 * row is flagged, so the completeness gate (validate.js) counted 4 permanent
 * "missing" pre-renders and hard-failed `snapshot build` — the JS-side gate
 * that blocked the weekly archive once the Swift build stopped blocking it.
 *
 * So make the concept per-variant: a JSON array of `"<weight>/<scale>"`
 * strings the renderer could not produce. The prerender loop records the
 * partial set, the validator skips exactly those variants (and keeps
 * counting anything else as missing, so genuine gaps stay loud), and the
 * v27 all-variants flag keeps its meaning for a wholly-absent glyph.
 */
export function up(db) {
  try {
    db.run("ALTER TABLE sf_symbols ADD COLUMN unsupported_variants TEXT NOT NULL DEFAULT '[]'")
  } catch (e) {
    // Idempotent re-run.
    if (!/duplicate column name/i.test(e.message ?? '')) throw e
  }
}
