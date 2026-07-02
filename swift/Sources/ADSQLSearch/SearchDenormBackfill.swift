public import ADDBExec
public import ADSQLModel
import ADDBJSON  // JSON_EXTRACT registration (the year/track folds) — see `enableJSON()` below

/// Populates the apple-docs NATIVE search-denorm columns
/// (`documents.{title_lc,key_lc,year_num,track_lc,root_display,root_slug}`, the v28 set) over a DB that
/// was produced by importing the JS-writer SQLite (`ADSQLImport`) — the preparation step the 5A read
/// swap runs once before serving with ``SearchQuery/denormSQL``.
///
/// The folds are computed the SAME way the §2.2 query computes them inline, so a row populated here makes
/// ``SearchQuery/denormSQL`` a faithful rewrite of ``SearchQuery/sql``:
///   - `title_lc` / `key_lc` / `track_lc` and the `year` extract are done by the engine's own
///     `LOWER` / `COALESCE` / `JSON_EXTRACT` scalars (identical to the oracle's), via one SELECT;
///   - the `root_display` / `root_slug` framework→roots fold is a `COALESCE(roots.…, framework)` done in
///     Swift over a roots map, because the engine does not yet support the correlated scalar subquery the
///     in-SQL form would need (it throws `sqlUnsupported`). The map form is the same COALESCE result.
extension Database {
    /// Backfills the six denorm columns for every `documents` row. Idempotent (a re-run recomputes the
    /// same values). Runs in one pass: read the roots map, project the SQL-folded scalars, write each row.
    public func backfillSearchDenorm() throws(DBError) {
        // The year/track folds use `JSON_EXTRACT`, which is opt-in (ADSQLJSON). The denorm serving path
        // needs JSON registered anyway (the `$sources_json` filter uses `json_each`), so enabling it here
        // makes the backfill self-sufficient; `enableJSON()` is idempotent registration.
        enableJSON()

        // roots.slug → display_name. The denorm join is `roots r ON r.slug = d.framework`, so a document's
        // framework keys into this map; a miss falls back to the framework itself (the COALESCE default).
        var rootDisplayBySlug: [String: String] = [:]
        for row in try prepare("SELECT slug, display_name FROM roots").all() {
            guard case .text(let slug) = row["slug"] else { continue }
            if case .text(let display) = row["display_name"] { rootDisplayBySlug[slug] = display }
        }

        // The engine folds title/key/track + the year extract exactly as the §2.2 query does; framework is
        // carried through for the Swift-side roots COALESCE.
        let projected = try prepare(
            """
            SELECT id,
                   LOWER(title) AS title_lc,
                   LOWER(documents.key) AS key_lc,
                   JSON_EXTRACT(source_metadata, '$.year') AS year_raw,
                   LOWER(COALESCE(JSON_EXTRACT(source_metadata, '$.track'), '')) AS track_lc,
                   framework
            FROM documents
            """
        ).all()

        let update = try prepare(
            """
            UPDATE documents SET
              title_lc = $title_lc, key_lc = $key_lc, year_num = $year_num,
              track_lc = $track_lc, root_display = $root_display, root_slug = $root_slug
            WHERE id = $id
            """)

        for row in projected {
            guard case .integer(let id) = row["id"] else { continue }
            let framework: String = { if case .text(let f) = row["framework"] { return f } else { return "" } }()
            // root_display = COALESCE(r.display_name, framework); root_slug = COALESCE(r.slug, framework)
            // where r.slug == framework on a hit (the join key), so root_slug is `framework` either way.
            let display = rootDisplayBySlug[framework]
            _ = try update.run([
                "id": .integer(id),
                "title_lc": row["title_lc"] ?? .null,
                "key_lc": row["key_lc"] ?? .null,
                // year_num = CAST(json_extract(…,'$.year') AS INTEGER): json_extract already yields an
                // integer Value for a JSON integer; a non-integer / absent year folds to NULL.
                "year_num": integerOrNull(row["year_raw"]),
                "track_lc": row["track_lc"] ?? .text(""),
                "root_display": .text(display ?? framework),
                "root_slug": .text(framework)
            ])
        }
    }
}

/// `CAST(x AS INTEGER)`-style coercion to the `year_num` column: an integer Value passes through, a real
/// truncates, anything else (text/blob/NULL/absent) is NULL — matching the oracle's CAST of a non-numeric
/// `json_extract` result to NULL for this corpus (years are JSON integers).
private func integerOrNull(_ value: Value?) -> Value {
    switch value {
        case .some(.integer(let i)): return .integer(i)
        case .some(.real(let d)): return .integer(Int64(d))
        default: return .null
    }
}
