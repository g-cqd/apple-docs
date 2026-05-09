/**
 * Encode an Apple platform-version string into a sortable INTEGER.
 *
 * Apple version strings are nominal `MAJOR.MINOR[.PATCH]` (e.g. "17.4",
 * "10.15.1", "1.0"). Pre-v15a the documents table compared them as TEXT,
 * which gave the lexicographic surprise that `'10.0' < '9.0'`. v15a adds
 * INTEGER companion columns populated through this helper so filter
 * predicates compare numerically.
 *
 * Encoding: MAJOR * 1_000_000 + MINOR * 1_000 + PATCH. Triple-base of
 * 1000 covers every observed Apple version (largest historical patch
 * is in the dozens; reserving 999 leaves comfortable headroom). Fits
 * comfortably in INT — `99 999 999 999` ≪ 2^53.
 *
 * Returns `null` for missing or unparseable input so the SQL predicate
 * `($v IS NULL OR d.col IS NULL OR d.col <= $v)` keeps its NULL-tolerant
 * shape.
 */
const COMPONENT_BASE = 1_000

export function encodeVersion(text) {
  if (text == null) return null
  const trimmed = String(text).trim()
  if (trimmed === '') return null
  // Strip trailing markers like " beta" / "+" if Apple ever ships them.
  const numeric = trimmed.match(/^\d+(?:\.\d+){0,3}/)?.[0]
  if (!numeric) return null
  const parts = numeric.split('.').map((n) => Number.parseInt(n, 10))
  if (parts.some((n) => !Number.isFinite(n) || n < 0 || n >= COMPONENT_BASE)) return null
  const [major, minor = 0, patch = 0] = parts
  return major * COMPONENT_BASE * COMPONENT_BASE + minor * COMPONENT_BASE + patch
}
