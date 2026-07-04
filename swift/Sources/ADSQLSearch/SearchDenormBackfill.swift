public import ADDBExec
import ADDBJSON  // JSON_EXTRACT registration (the year/track folds) — see `enableJSON()` below
public import ADSQLModel

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
    /// Backfills the six denorm columns for every `documents` row that still needs it (`root_slug IS NULL`
    /// — the writer never sets the v28 denorm set, so NULL marks an un-backfilled row). Incremental: a
    /// re-crawl that appended pages backfills only the new rows' folds, and a fully-populated corpus updates
    /// zero rows. Idempotent (a re-run recomputes the same values). Runs as BULK statements — one scan for
    /// the SQL-folded columns + a bounded per-root override for `root_display` — to stay linear (see below).
    public func backfillSearchDenorm() throws(DBError) {
        // The year/track folds use `JSON_EXTRACT`, which is opt-in (ADSQLJSON). The denorm serving path
        // needs JSON registered anyway (the `$sources_json` filter uses `json_each`), so enabling it here
        // makes the backfill self-sufficient; `enableJSON()` is idempotent registration.
        enableJSON()

        // roots.slug → display_name, for the `root_display` override below (the one column needing the
        // roots join, which the engine can't do as a correlated subquery).
        var rootDisplayBySlug: [String: String] = [:]
        for row in try prepare("SELECT slug, display_name FROM roots").all() {
            guard case .text(let slug) = row["slug"] else { continue }
            if case .text(let display) = row["display_name"] { rootDisplayBySlug[slug] = display }
        }

        // Nothing to backfill? `root_slug` is the framework after this runs and NULL before it, so one NULL
        // probe answers it (prepareForDenormServing guards the same; kept so a direct call is a no-op too).
        guard try !prepare("SELECT 1 FROM documents WHERE root_slug IS NULL LIMIT 1").all().isEmpty else {
            return
        }

        // Suspend the `documents` FTS-sync triggers, then backfill in BULK. A per-row `UPDATE … WHERE id=?`
        // is O(N²): ADDB collects an UPDATE's matches by a full table scan (`Writer.collectMatches`), so one
        // scan per row. Instead ONE scan folds the five SQL-computable columns + the `root_slug = framework`
        // default, then a bounded per-root pass overrides `root_display` — O(roots·N), not O(N²). The six
        // columns aren't FTS-indexed, so suspending the au trigger loses nothing and skips a posting
        // re-encode per row. One transaction: a throw rolls it all back with the triggers intact.
        try suspendingTriggers(on: "documents") { (txn) throws(DBError) in
            _ = try txn.run(
                """
                UPDATE documents SET
                  title_lc = LOWER(title),
                  key_lc = LOWER(documents.key),
                  year_num = CAST(JSON_EXTRACT(source_metadata, '$.year') AS INTEGER),
                  track_lc = LOWER(COALESCE(JSON_EXTRACT(source_metadata, '$.track'), '')),
                  root_slug = framework,
                  root_display = framework
                WHERE root_slug IS NULL
                """)
            // root_display = COALESCE(r.display_name, framework): override the framework default for each
            // root whose display differs (bounded by the root count, not the document count).
            for (slug, display) in rootDisplayBySlug where display != slug {
                _ = try txn.run(
                    "UPDATE documents SET root_display = $display WHERE framework = $slug",
                    ["display": .text(display), "slug": .text(slug)])
            }
        }
    }
}
