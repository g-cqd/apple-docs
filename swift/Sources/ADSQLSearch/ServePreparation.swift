public import ADDBExec
import ADDBFTS  // enableFullTextSearch() — `documents_fts MATCH` is opt-in
import ADDBJSON  // enableJSON() — hoisted so the live filters' json_each/json_extract work on the skip path
public import ADSQLModel  // DBError (the typed-throws error in the public signature)

/// Makes an `ADSQLImport`-produced ADDB database ready to serve the apple-docs search read path — the
/// one-call setup the 5A read swap performs once, after import, before the first `/search`.
///
/// It bundles the three serving invariants the denormalized search query depends on (each discovered to
/// be required and individually gated): the opt-in **full-text-search** function set (`documents_fts
/// MATCH` / `bm25`), the opt-in **JSON** function set (`json_each`/`json_extract` in the §2.4 filters —
/// enabled transitively by the backfill), and the populated **v28 denorm columns**
/// (``Database/backfillSearchDenorm()``). After this returns, ``Database/searchPagesFramedDenorm(_:)``
/// produces output byte-identical to the normalized ``Database/searchPagesFramed(_:)`` (proven by
/// `SearchDenormEquivalenceTests`).
///
/// Idempotent: the enables are registration (safe to repeat) and the backfill recomputes the same values.
/// Fast to REPEAT: after the first backfill every subsequent call short-circuits at the guard below, so an
/// `ADDBBackend` that re-runs this on every read-open pays only a single cheap probe, not the full pass.
extension Database {
    public func prepareForDenormServing() throws(DBError) {
        enableFullTextSearch()
        // The year/track folds AND the live §2.4 filters use `JSON_EXTRACT`/`json_each`, so JSON must be
        // registered whether or not the backfill runs — hoisted out of `backfillSearchDenorm()` (which the
        // guard below may skip). Registration is idempotent.
        enableJSON()
        // GUARD: skip the backfill when every row is already populated. `backfillSearchDenorm` UPDATEs
        // `documents` per row, and the blanket `documents_au AFTER UPDATE` trigger re-encodes the whole
        // `documents_fts`/`documents_trigram` postings on each — quadratic in the row count and the 25s+
        // per-open cost that made native-corpus search unusable. `root_slug` is set to the framework (never
        // NULL) by the backfill and is NULL beforehand (the crawl/import writer never populates the v28
        // denorm columns — `ADWrite.CrawlPersist.documentsUpsertSQL`), so a single NULL probe answers
        // "does any row still need it?". `.run` commits per statement, so a prior backfill persists across
        // opens — this probe returns empty and we return without touching a single row.
        let pending = try prepare("SELECT 1 FROM documents WHERE root_slug IS NULL LIMIT 1").all()
        guard !pending.isEmpty else { return }
        try backfillSearchDenorm()
    }
}
