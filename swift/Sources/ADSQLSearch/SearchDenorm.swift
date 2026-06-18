/// — the helpers that
/// precompute the denormalized `documents` columns the ``SearchQuery/denormSQL``
/// read query consumes. Each helper reproduces, in Swift, the EXACT SQLite scalar
/// the denorm column folds away, so a row populated with these values makes the
/// denorm query a faithful rewrite of the §2.2 form:
///
/// | denorm column | folds the §2.2 expression |
/// |-----------------|--------------------------------------------------------------------|
/// | `title_lc` | `LOWER(d.title)` |
/// | `key_lc` | `LOWER(d.key)` |
/// | `year_num` | `CAST(json_extract(d.source_metadata, '$.year') AS INTEGER)` |
/// | `track_lc` | `LOWER(COALESCE(json_extract(d.source_metadata, '$.track'), ''))` |
/// | `root_display` | `COALESCE(r.display_name, d.framework)` |
/// | `root_slug` | `COALESCE(r.slug, d.framework)` |
///
/// The denormalization is computed at build time from the STRUCTURED inputs the
/// corpus already holds (the year `Int64`, the track `String?`, the framework, the
/// roots map) — not by re-parsing the JSON metadata string. The equivalence test
/// (`SearchDenormEquivalenceTests`) then proves these match the SQLite scalars
/// (`LOWER`/`CAST`/`json_extract` via the oracle) on the same fixture.
public enum SearchDenorm {
  /// SQLite/ADSQL `LOWER(text)` — an ASCII-only case fold (`A`–`Z` → `a`–`z`; every
  /// other scalar is unchanged), matching `SQLFunctions.call("LOWER", …)` /
  /// `SQLFunctions.like`'s `foldScalar`. NOT Unicode case folding — SQLite's core
  /// `LOWER` only touches ASCII, and the tier `CASE` / `track_like` compares depend
  /// on that exact (limited) fold.
  public static func lower(_ text: String) -> String {
    String(
      String.UnicodeScalarView(
        text.unicodeScalars.map { scalar in
          (scalar.value >= 0x41 && scalar.value <= 0x5A)
            // A–Z + 0x20 is a–z (0x61–0x7A): always a valid ASCII scalar,
            // so the non-failable UInt8 initializer is exact (no force-unwrap).
            ? Unicode.Scalar(UInt8(scalar.value + 0x20)) : scalar
        }))
  }

  /// `year_num` = `CAST(json_extract(source_metadata, '$.year') AS INTEGER)`.
  /// When the metadata has a `year` (always a JSON integer in this corpus),
  /// `json_extract` returns that integer and the `CAST` is identity; when the key
  /// is absent, `json_extract` is NULL and the `CAST` of NULL is NULL. So the
  /// denorm value is the structured year, or `nil` (⇒ a NULL column) when absent.
  public static func yearNum(_ year: Int64?) -> Int64? {
    year
  }

  /// `track_lc` = `LOWER(COALESCE(json_extract(source_metadata, '$.track'), ''))`.
  /// `json_extract('$.track')` is the JSON string when present, else NULL; the
  /// `COALESCE(…, '')` turns the NULL into the empty string; `LOWER` ASCII-folds
  /// it. So an absent track folds to `""` (NOT NULL) — the column is never NULL,
  /// which is exactly what the `track_lc LIKE $track_like` denorm filter needs.
  public static func trackLC(_ track: String?) -> String {
    lower(track ?? "")
  }

  /// `root_display` = `COALESCE(r.display_name, d.framework)` — the LEFT JOIN
  /// `roots r ON r.slug = d.framework`'s `display_name` when a roots row matches
  /// `framework`, else `framework` itself (the COALESCE fallback).
  public static func rootDisplay(framework: String, displayName: String?) -> String {
    displayName ?? framework
  }

  /// `root_slug` = `COALESCE(r.slug, d.framework)` — the matched roots `slug` (which
  /// equals `framework`, since the join is `r.slug = d.framework`), else `framework`.
  /// In both the hit and miss case this is `framework`, but it is computed via the
  /// same COALESCE shape so the fold is provably faithful.
  public static func rootSlug(framework: String, slug: String?) -> String {
    slug ?? framework
  }
}
