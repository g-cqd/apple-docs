public import ADDBExec
public import ADSQLModel  // DBError (the typed-throws error in the public signature)
import ADDBFTS  // enableFullTextSearch() — `documents_fts MATCH` is opt-in

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
extension Database {
    public func prepareForDenormServing() throws(DBError) {
        enableFullTextSearch()
        // `backfillSearchDenorm()` itself calls `enableJSON()` (its year/track folds use `JSON_EXTRACT`),
        // which also satisfies the `json_each` in the live filters — so JSON is registered here too.
        try backfillSearchDenorm()
    }
}
