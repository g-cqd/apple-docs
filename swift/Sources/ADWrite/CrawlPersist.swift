// CrawlPersist — the native apple-docs crawl PERSIST on the ADDB engine
// ("ADSQLv0"). The row-writing heart of the storage writer: it mirrors the Bun
// `bun:sqlite` persist (apple-docs/src/pipeline/persist.js + src/storage/repos/*)
// statement-for-statement, writing the SAME rows the JS writer emits.
//
// Scope (this slice): the DB rows ONLY —
//   • `upsertRoot`  ← roots repo `upsertRoot`
//   • `persistNormalized` ← persist.js `persistNormalizedPage`'s `db.tx` body:
//       `upsertPageFromDocument` → `db.upsertPage({…, skipDocumentSync:true})`
//       (writes the pages row), then `db.upsertNormalizedDocument(normalized)`
//       (writes the documents row + replaces document_sections +
//       document_relationships), then `db.markConverted(path)`.
// Out of scope (LATER slices): the raw-json/markdown FILE writes, chunks/vectors
// embeddings, and the snapshot build. The schema is already ported
// (AppleDocsSchema.migrateSchema); this persist runs AFTER it on the same DB.
//
// ── JS → ADDB faithful reproduction ───────────────────────────────────────────
// Every INSERT uses the EXACT SQL text from the JS repo (same column set, same
// `ON CONFLICT … DO UPDATE`, same `$name` placeholders) — ADSQL's lexer accepts
// `$name`/`:name` named parameters (resolved without the sigil), so the SQL is
// the literal JS string. Derived values reproduce the JS helpers bit-for-bit:
//   • serializePlatforms      (documents.js)      → passthrough string / JSON
//   • encodeVersion           (lib/version-encode.js) → MAJOR*1e6+MINOR*1e3+PATCH
//   • coerceSourceType        (storage/source-types.js)
//   • deriveRootSourceType    (storage/source-types.js)
//   • deriveFrameworkFromPath (storage/repos/*.js)
//   • url_depth               (facade upsertPage)  → max(0, path.split('/').len-1)
//
// ── Content codec (sections) ──────────────────────────────────────────────────
// The persist path writes document_sections.content_text / content_json as PLAIN
// TEXT — the zstd codec (storage/section-codec.js `encodeSectionContent`) is used
// ONLY by `storage compact` / `snapshot`, NEVER by the writer. content_text is
// NOT NULL, so a null normalized contentText is stored as '' (mirrors the JS
// `section.contentText ?? ''`); content_json passes through (nullable).
//
// ── Wall-clock columns ────────────────────────────────────────────────────────
// `first_seen`/`last_seen` (roots), `downloaded_at`/`converted_at` (pages),
// `created_at`/`updated_at` (documents) are bound to a caller-supplied ISO-8601
// `now` (the JS binds `new Date().toISOString()`). They are wall-clock and so are
// EXCLUDED from the parity comparison, but writing them keeps the rows complete.

// `public import` for ADDB (`Database` appears in every public signature) and
// for ADSQLModel (`DBError` is the typed-throws error in the public
// `throws(DBError)` contracts — an internal import would leak it). `Value` is
// also used in bodies; both modules are genuinely part of the public surface, so
// neither triggers the unused-`public import` warning under InternalImportsByDefault.

// swiftlint:disable file_length  // the statement-for-statement JS persist port is legitimately long

public import ADDB
public import ADSQLModel

/// The native crawl persist. A namespace of pure write functions over an open,
/// writable ADDB `Database` whose schema is already at `AppleDocsSchema`.
public enum CrawlPersist {
    /// The two content hashes threaded into a persist: `content` (the normalized document hash) and
    /// `rawPayload` (the upstream payload hash). Bundled so `persistNormalized` stays within the
    /// parameter-count gate.
    public struct DocumentHashes: Sendable, Equatable {
        public let content: String
        public let rawPayload: String
        public init(content: String, rawPayload: String) {
            self.content = content
            self.rawPayload = rawPayload
        }
    }

    // MARK: - roots

    /// Upserts a documentation root, mirroring `repos/roots.js` `upsertRoot`
    /// (INSERT … ON CONFLICT(slug) DO UPDATE). Derives `source_type` via
    /// `deriveRootSourceType(slug, kind)` when `sourceType` is nil, exactly as the
    /// JS does. `first_seen`/`last_seen` are bound to `now` (wall-clock).
    ///
    /// - Returns: the root's `id` (rowid) — fresh on insert, the existing id on a
    ///   conflicting update (ADDB's `lastInsertRowid` tracks both branches).
    @discardableResult
    public static func upsertRoot(
        _ db: Database, slug: String, displayName: String, kind: String, source: String,
        seedPath: String? = nil, sourceType: String? = nil, now: String
    ) throws(DBError) -> Int64 {
        let resolvedSourceType = sourceType ?? deriveRootSourceType(slug: slug, kind: kind)
        var rowid: Int64 = 0
        try db.transaction { (txn) throws(DBError) in
            // Verbatim from roots.js (status hardcoded 'active'; $now → first/last_seen).
            let result = try txn.run(
                """
                INSERT INTO roots (slug, display_name, kind, status, source, seed_path, source_type, first_seen, last_seen)
                VALUES ($slug, $display_name, $kind, 'active', $source, $seed_path, $source_type, $now, $now)
                ON CONFLICT(slug) DO UPDATE SET
                  display_name = $display_name,
                  kind = CASE WHEN excluded.kind != 'unknown' THEN excluded.kind ELSE roots.kind END,
                  seed_path = COALESCE($seed_path, roots.seed_path),
                  last_seen = $now,
                  source = $source,
                  source_type = COALESCE($source_type, roots.source_type)
                RETURNING id
                """,
                [
                    "slug": .text(slug),
                    "display_name": .text(displayName),
                    "kind": .text(kind),
                    "source": .text(source),
                    "seed_path": seedPath.map(Value.text) ?? .null,
                    "source_type": .text(resolvedSourceType),
                    "now": .text(now)
                ])
            rowid = result.lastInsertRowid
        }
        return rowid
    }

    /// Recompute `roots.page_count` for one root (JS `db.updateRootPageCount(slug)`, called once a root's
    /// crawl loop exhausts — `repos/roots.js` `UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages
    /// WHERE root_id = roots.id AND status = 'active') WHERE slug = ?`). ADDB's planner rejects a
    /// correlated subquery inside an UPDATE (the same "derived table" gap `ADStorage/Frameworks.swift`
    /// routes around for reads), so this reads the count with a plain SELECT first, then writes it back
    /// with a plain UPDATE, instead of the JS's single correlated statement.
    public static func refreshRootPageCount(_ db: Database, rootId: Int64) throws(DBError) {
        let rows =
            try db.prepare("SELECT COUNT(*) AS c FROM pages WHERE root_id = $root_id AND status = 'active'")
            .all(["root_id": .integer(rootId)])
        var count: Int64 = 0
        if let row = rows.first, case .integer(let c)? = row["c"] { count = c }
        try db.transaction { (txn) throws(DBError) in
            _ = try txn.run(
                "UPDATE roots SET page_count = $page_count WHERE id = $id",
                ["page_count": .integer(count), "id": .integer(rootId)])
        }
    }

    // MARK: - reads

    /// The HTTP validators (`etag` / `last_modified`) stored for the page at `path`, or `nil` when no
    /// page row exists. The incremental re-crawl reads this back BEFORE fetching and feeds the `etag`
    /// into the adapter's conditional `check` (`If-None-Match`), so an unchanged upstream resource is
    /// skipped without re-downloading. A single-row projection in the IndexEmbeddings read-helper idiom.
    public static func pageValidator(
        _ db: Database, path: String
    ) throws(DBError) -> (etag: String?, lastModified: String?)? {
        let rows = try db.prepare("SELECT etag, last_modified FROM pages WHERE path = $path")
            .all(["path": .text(path)])
        guard let row = rows.first else { return nil }
        return (etag: cellText(row["etag"]), lastModified: cellText(row["last_modified"]))
    }

    // MARK: - crawl_state work-queue (BFS)
    //
    // The reference-following crawl's frontier: one row per discovered path (pending → processed /
    // failed), keyed by path with the seeding root_slug + BFS depth. Ports src/storage/repos/crawl.js
    // so a native crawl's queue is byte-identical to the JS crawler's.

    /// Upsert a crawl_state row (JS `setCrawlState`): set the path's `status` + `error`. `ON CONFLICT(path)`
    /// touches only status/error, so re-marking a path keeps its original `root_slug`/`depth`.
    public static func setCrawlState(
        _ db: Database, path: String, status: String, rootSlug: String, depth: Int = 0,
        error: String? = nil
    ) throws(DBError) {
        try db.transaction { (txn) throws(DBError) in
            _ = try txn.run(
                """
                INSERT INTO crawl_state (path, status, root_slug, depth, error)
                VALUES ($path, $status, $root_slug, $depth, $error)
                ON CONFLICT(path) DO UPDATE SET status = $status, error = $error
                """,
                [
                    "path": .text(path), "status": .text(status), "root_slug": .text(rootSlug),
                    "depth": .integer(Int64(depth)), "error": error.map(Value.text) ?? .null
                ])
        }
    }

    /// Bulk-mark a batch of already-tracked paths `processed` in ONE `UPDATE` — one `crawl_state` scan for
    /// the whole batch, not one per path. ADDB collects an UPDATE's matches by a full table scan
    /// (`Writer.collectMatches`), so a per-row `setCrawlState` is O(N) each and O(N²) over a frontier that
    /// grows toward the corpus size; the `path IN (…)` batch amortizes the scan by the batch width. Clears
    /// any prior error. Paths must already exist (they were seeded `pending`).
    public static func markCrawlProcessed(_ db: Database, paths: [String]) throws(DBError) {
        guard !paths.isEmpty else { return }
        var placeholders: [String] = []
        placeholders.reserveCapacity(paths.count)
        var params: [String: Value] = [:]
        for (index, path) in paths.enumerated() {
            placeholders.append("$p\(index)")
            params["p\(index)"] = .text(path)
        }
        let sql =
            "UPDATE crawl_state SET status = 'processed', error = NULL WHERE path IN ("
            + placeholders.joined(separator: ", ") + ")"
        try db.transaction { (txn) throws(DBError) in _ = try txn.run(sql, params) }
    }

    /// One-time (idempotent): index `crawl_state.status` so `getPendingCrawlAny` (`WHERE status='pending'`)
    /// is an index seek rather than a scan that skips past an ever-growing pile of `processed` rows.
    public static func ensureCrawlStatusIndex(_ db: Database) throws(DBError) {
        try db.transaction { (txn) throws(DBError) in
            _ = try txn.run("CREATE INDEX IF NOT EXISTS idx_crawl_state_status ON crawl_state(status)")
        }
    }

    /// Seed a path as `pending` only if not already tracked (JS `seedCrawlIfNew`), so re-discovering a
    /// path never resets a `processed`/`failed` row. Returns `true` when a new row was inserted.
    @discardableResult
    public static func seedCrawlIfNew(
        _ db: Database, path: String, rootSlug: String, depth: Int = 0
    ) throws(DBError) -> Bool {
        let existing = try db.prepare("SELECT 1 FROM crawl_state WHERE path = $path")
            .all(["path": .text(path)])
        guard existing.isEmpty else { return false }
        // A PLAIN insert (the row is known-new from the probe above). setCrawlState's `INSERT … ON CONFLICT
        // DO UPDATE` makes the engine collect the (non-existent) conflict by a full `crawl_state` scan —
        // O(N) per seed, O(N²) over a frontier that grows to the corpus size (millions of refs seeded).
        try db.transaction { (txn) throws(DBError) in
            _ = try txn.run(
                """
                INSERT INTO crawl_state (path, status, root_slug, depth, error)
                VALUES ($path, 'pending', $root_slug, $depth, NULL)
                """,
                ["path": .text(path), "root_slug": .text(rootSlug), "depth": .integer(Int64(depth))])
        }
        return true
    }

    /// Batched `seedCrawlIfNew`: probe every ref, then insert all genuinely-new ones in ONE transaction
    /// instead of one transaction per ref. A reference-following page seeds many same-root refs (dozens on
    /// a framework landing page), and the per-ref transaction was the crawl's dominant serial-write cost
    /// (the single-writer ceiling that capped a wide crawl near ~70 pages/s). The probes stay per-path — an
    /// index seek on the unique `path` — but the N inserts collapse to a single commit. Intra-batch duplicate
    /// paths are de-duplicated first-wins, matching the per-ref loop where the second `seedCrawlIfNew` for a
    /// path would find the first's freshly-committed row and skip. Returns the count newly seeded.
    @discardableResult
    public static func seedCrawlBatch(
        _ db: Database, _ seeds: [(path: String, rootSlug: String, depth: Int)]
    ) throws(DBError) -> Int {
        guard !seeds.isEmpty else { return 0 }
        var seen: Set<String> = []
        var fresh: [(path: String, rootSlug: String, depth: Int)] = []
        for seed in seeds where seen.insert(seed.path).inserted {
            let existing = try db.prepare("SELECT 1 FROM crawl_state WHERE path = $path")
                .all(["path": .text(seed.path)])
            if existing.isEmpty { fresh.append(seed) }
        }
        guard !fresh.isEmpty else { return 0 }
        try db.transaction { (txn) throws(DBError) in
            for seed in fresh {
                _ = try txn.run(
                    """
                    INSERT INTO crawl_state (path, status, root_slug, depth, error)
                    VALUES ($path, 'pending', $root_slug, $depth, NULL)
                    """,
                    [
                        "path": .text(seed.path), "root_slug": .text(seed.rootSlug),
                        "depth": .integer(Int64(seed.depth))
                    ])
            }
        }
        return fresh.count
    }

    /// The next batch of `pending` paths for a root (JS `getPendingCrawl`): `(path, depth)`, up to `limit`.
    /// `limit` is a trusted caller constant, interpolated (ADSQL's `LIMIT` takes no bind parameter).
    public static func getPendingCrawl(
        _ db: Database, rootSlug: String, limit: Int = 10
    ) throws(DBError) -> [(path: String, depth: Int)] {
        let rows =
            try db.prepare(
                "SELECT path, depth FROM crawl_state WHERE status = 'pending' AND root_slug = $slug"
                    + " LIMIT \(Swift.max(0, limit))"
            )
            .all(["slug": .text(rootSlug)])
        return rows.compactMap { row in
            guard let path = cellText(row["path"]) else { return nil }
            var depth = 0
            if case .integer(let d)? = row["depth"] { depth = Int(d) }
            return (path: path, depth: depth)
        }
    }

    /// The next `limit` `pending` rows across every root in `rootSlugs`, each carrying its stored
    /// `root_slug`. Feeds a cross-root BFS frontier: pooling every root THIS CALL OWNS into one wave keeps
    /// the fetch fan-out saturated even when individual roots have narrow early levels — the JS
    /// shared-semaphore crawl (`discover.js`, one pool across roots) rather than root-at-a-time.
    ///
    /// `rootSlugs` is the hard boundary that keeps one source's `crawl()` call from ever draining a
    /// DIFFERENT source's leftover backlog (RFC 0007 §11 finding #2): before this filter existed, an
    /// interrupted source (e.g. a long-running `apple-docc` crawl) left `pending` rows that whichever
    /// `.crawl`-mode source ran next — unrelated, with its own unrelated `rootIds` — would happily pull
    /// and persist via that caller's `rootIds[f.rootSlug] ?? rootId` fallback, mis-stamping `pages.root_id`
    /// with the WRONG source's default root. Scoping the pull to `rootSlugs` (the caller's own root set)
    /// makes that fallback unreachable for foreign rows: they simply never surface here. An empty
    /// `rootSlugs` can't match anything meaningful, so it short-circuits to no rows rather than degrading
    /// to the old unfiltered (and now unsafe) behavior.
    ///
    /// `limit` is a trusted caller constant, interpolated (ADSQL's `LIMIT` takes no bind parameter); the
    /// `root_slug IN (…)` list uses one `$s<N>` placeholder per slug — same discipline as
    /// `markCrawlProcessed`'s batched `IN (…)`, since ADSQL's `IN` needs a literal placeholder per value,
    /// not a single array bind.
    public static func getPendingCrawlAny(
        _ db: Database, rootSlugs: Set<String>, limit: Int = 10
    ) throws(DBError) -> [(path: String, rootSlug: String, depth: Int)] {
        guard !rootSlugs.isEmpty else { return [] }
        var placeholders: [String] = []
        placeholders.reserveCapacity(rootSlugs.count)
        var params: [String: Value] = [:]
        for (index, slug) in rootSlugs.enumerated() {
            placeholders.append("$s\(index)")
            params["s\(index)"] = .text(slug)
        }
        let sql =
            "SELECT path, root_slug, depth FROM crawl_state WHERE status = 'pending' AND root_slug IN ("
            + placeholders.joined(separator: ", ") + ")"
            + " LIMIT \(Swift.max(0, limit))"
        let rows = try db.prepare(sql).all(params)
        return rows.compactMap { row in
            guard let path = cellText(row["path"]), let slug = cellText(row["root_slug"]) else {
                return nil
            }
            var depth = 0
            if case .integer(let d)? = row["depth"] { depth = Int(d) }
            return (path: path, rootSlug: slug, depth: depth)
        }
    }

    /// The `(pending, processed, failed)` counts for a root (JS `getCrawlStats`).
    public static func getCrawlStats(
        _ db: Database, rootSlug: String
    ) throws(DBError) -> (pending: Int, processed: Int, failed: Int) {
        let rows =
            try db.prepare(
                "SELECT status, COUNT(*) AS c FROM crawl_state WHERE root_slug = $slug GROUP BY status"
            )
            .all(["slug": .text(rootSlug)])
        var pending = 0
        var processed = 0
        var failed = 0
        for row in rows {
            var count = 0
            if case .integer(let c)? = row["c"] { count = Int(c) }
            switch cellText(row["status"]) {
                case "pending": pending = count
                case "processed": processed = count
                case "failed": failed = count
                default: break
            }
        }
        return (pending, processed, failed)
    }

    // MARK: - persistNormalized

    /// Persists a normalized document, mirroring `persist.js`
    /// `persistNormalizedPage`'s transactional body. In ONE ADDB transaction:
    ///   1. the pages row (`upsertPage` with skipDocumentSync — pages.js
    ///      `upsertPageRow`),
    ///   2. the documents row (`upsertNormalizedDocument` → documents.js
    ///      `upsertDocument`),
    ///   3. replace document_sections (documents.js `replaceSections`),
    ///   4. replace document_relationships (documents.js `replaceRelationships`),
    ///   5. markConverted (pages.js — sets converted_at).
    ///
    /// All five steps share one write transaction (the JS wraps them in `db.tx`),
    /// committing once. `contentHash`/`rawPayloadHash` flow into both the pages
    /// content_hash and the documents content_hash/raw_payload_hash columns,
    /// exactly as the JS persist threads them. `etag`/`lastModified` are the upstream
    /// HTTP validators (`FetchResult.etag`/`.lastModified`); they flow into the pages
    /// `etag`/`last_modified` columns so the incremental re-crawl can read them back
    /// for a conditional `check`. Defaulted to `nil` so the flat callers (parity /
    /// snapshot / index fixtures) that have no validators stay source-compatible — a
    /// `nil` is COALESCE-preserved against any existing row value, never overwriting it.
    public static func persistNormalized(
        _ db: Database, rootId: Int64, path: String, _ normalized: NormalizedDoc,
        hashes: DocumentHashes, etag: String? = nil, lastModified: String? = nil, now: String
    ) throws(DBError) {
        let doc = normalized.document

        // Only an EXISTING doc needs the "replace children" DELETEs + the pages markConverted UPDATE below.
        // A fresh page has no prior rows, so those would full-scan document_sections / document_relationships
        // / pages for nothing (the engine collects an UPDATE/DELETE's matches by a full table scan) — O(N²)
        // over a corpus that grows into the hundreds of thousands. `documents.key` is UNIQUE-indexed, so this
        // probe is a cheap seek; on a first crawl it's always false and the scans never run.
        let isReplace =
            try !db.prepare("SELECT 1 FROM documents WHERE key = $key")
            .all(["key": .text(doc.key)]).isEmpty

        try db.transaction { (txn) throws(DBError) in
            try insertPageRow(
                txn, rootId: rootId, path: path, normalized, rawPayloadHash: hashes.rawPayload,
                etag: etag, lastModified: lastModified, now: now)

            let documentId = try insertDocumentRow(
                txn, normalized, contentHash: hashes.content, rawPayloadHash: hashes.rawPayload, now: now)

            // ── 3. replace document_sections ────────────────────────────────────
            // documents.js replaceSections: delete all for the doc, then insert each
            // with ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE.
            //
            // ADDB's ON CONFLICT parser accepts only a SINGLE target column — a
            // COMPOSITE conflict target is rejected (DBError "expected ')'"). But in
            // the REPLACE path the preceding DELETE-all guarantees no row collision,
            // so the upsert's ON CONFLICT branch is dead; the only thing it provides
            // is INTRA-batch dedup (a later section with the same composite key
            // overwrites an earlier one — last-wins). We reproduce that EXACTLY by
            // deduping in Swift (last-wins, preserving first-seen order) then issuing
            // PLAIN inserts. The resulting rows are byte-identical to the JS upsert's.
            if isReplace {
                try txn.run(
                    "DELETE FROM document_sections WHERE document_id = $document_id",
                    ["document_id": .integer(documentId)])
            }
            for section in dedupedLastWins(
                normalized.sections, key: { "\($0.sectionKind)\u{1F}\($0.sortOrder)" })
            {
                try txn.run(
                    """
                    INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
                    VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
                    """,
                    [
                        "document_id": .integer(documentId),
                        "section_kind": .text(section.sectionKind),
                        "heading": section.heading.map(Value.text) ?? .null,
                        // content_text is NOT NULL; null normalized text → '' (JS `?? ''`).
                        // Plain TEXT — the zstd codec is compact/snapshot-only.
                        "content_text": .text(section.contentText ?? ""),
                        "content_json": section.contentJson.map(Value.text) ?? .null,
                        "sort_order": .integer(Int64(section.sortOrder))
                    ])
            }

            // ── 4. replace document_relationships ───────────────────────────────
            // documents.js replaceRelationships(fromKey=normalized.document.key):
            // delete all from that key, then insert each with ON CONFLICT(from_key,
            // to_key, relation_type) DO UPDATE. Same composite-conflict-target story
            // as sections: the DELETE-all makes the upsert branch dead except for
            // intra-batch last-wins dedup, which we reproduce in Swift, then PLAIN
            // insert. The from_key is the document key (the relationship's own
            // fromKey falls back to it).
            if isReplace {
                try txn.run(
                    "DELETE FROM document_relationships WHERE from_key = $from_key",
                    ["from_key": .text(doc.key)])
            }
            for relationship in dedupedLastWins(
                normalized.relationships,
                key: { "\($0.fromKey ?? doc.key)\u{1F}\($0.toKey)\u{1F}\($0.relationType)" })
            {
                try txn.run(
                    """
                    INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
                    VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
                    """,
                    [
                        "from_key": .text(relationship.fromKey ?? doc.key),
                        "to_key": .text(relationship.toKey),
                        "relation_type": .text(relationship.relationType),
                        "section": relationship.section.map(Value.text) ?? .null,
                        "sort_order": .integer(Int64(relationship.sortOrder ?? 0))
                    ])
            }

            // ── 5. markConverted ────────────────────────────────────────────────
            // pages.js markConverted: UPDATE pages SET converted_at = ? WHERE path = ?
            // (wall-clock; excluded from parity). Only on a re-persist — a fresh page's row was just
            // inserted (converted_at NULL, non-parity), and the UPDATE would otherwise full-scan `pages`.
            if isReplace {
                try txn.run(
                    "UPDATE pages SET converted_at = $converted_at WHERE path = $path",
                    ["converted_at": .text(now), "path": .text(path)])
            }
        }
    }
}

// Bit-for-bit reproductions of the JS persist helpers (source-type coercion, framework derivation,
// platform/metadata serialization, version encoding, last-wins dedup). Split from the enum body to
// stay within the size/complexity gate; each mirrors its cited JS function exactly.
extension CrawlPersist {
    /// Step 1 of `persistNormalized`: the pages-row upsert (pages.js upsertPageRow).
    private static func insertPageRow(
        _ txn: SQLTransaction, rootId: Int64, path: String, _ normalized: NormalizedDoc,
        rawPayloadHash: String, etag: String? = nil, lastModified: String? = nil, now: String
    ) throws(DBError) {
        let doc = normalized.document
        // ── 1. pages row ────────────────────────────────────────────────────
        // persist.js upsertPageFromDocument → db.upsertPage. The facade derives
        // source_type (doc.sourceType ?? fallback ?? root.source_type ?? default)
        // and url_depth (doc.urlDepth ?? max(0, path.split('/').len-1)). For the
        // normalized path the doc carries both, so we use them directly; the
        // facade's root lookup only matters when the doc omits them.
        let pageSourceType = doc.sourceType ?? DEFAULT_SOURCE_TYPE
        let pageUrlDepth = doc.urlDepth ?? max(0, path.split(separator: "/", omittingEmptySubsequences: true).count - 1)
        // pages.js upsertPageRow — verbatim column set + ON CONFLICT(path).
        try txn.run(
            """
            INSERT INTO pages (
              root_id, path, url, title, role, role_heading, abstract, platforms, declaration,
              etag, last_modified, content_hash, downloaded_at, status,
              source_type, language, is_release_notes, url_depth, doc_kind, source_metadata,
              min_ios, min_macos, min_watchos, min_tvos, min_visionos
            )
            VALUES (
              $root_id, $path, $url, $title, $role, $role_heading, $abstract, $platforms, $declaration,
              $etag, $last_modified, $content_hash, $downloaded_at, 'active',
              $source_type, $language, $is_release_notes, $url_depth, $doc_kind, $source_metadata,
              $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos
            )
            ON CONFLICT(path) DO UPDATE SET
              title = COALESCE($title, pages.title),
              role = COALESCE($role, pages.role),
              role_heading = COALESCE($role_heading, pages.role_heading),
              abstract = COALESCE($abstract, pages.abstract),
              platforms = COALESCE($platforms, pages.platforms),
              declaration = COALESCE($declaration, pages.declaration),
              etag = COALESCE($etag, pages.etag),
              last_modified = COALESCE($last_modified, pages.last_modified),
              content_hash = COALESCE($content_hash, pages.content_hash),
              downloaded_at = COALESCE($downloaded_at, pages.downloaded_at),
              source_type = COALESCE($source_type, pages.source_type),
              language = COALESCE($language, pages.language),
              is_release_notes = COALESCE($is_release_notes, pages.is_release_notes),
              url_depth = COALESCE($url_depth, pages.url_depth),
              doc_kind = COALESCE($doc_kind, pages.doc_kind),
              source_metadata = COALESCE($source_metadata, pages.source_metadata),
              min_ios = COALESCE($min_ios, pages.min_ios),
              min_macos = COALESCE($min_macos, pages.min_macos),
              min_watchos = COALESCE($min_watchos, pages.min_watchos),
              min_tvos = COALESCE($min_tvos, pages.min_tvos),
              min_visionos = COALESCE($min_visionos, pages.min_visionos),
              status = 'active'
            """,
            [
                "root_id": .integer(rootId),
                // persist.js: url = doc.url ?? defaultUrl ?? null. For the
                // normalized path defaultUrl is unset (sourceTypeFallback path),
                // so url is doc.url (always set by normalize) or null.
                "path": .text(path),
                "url": doc.url.map(Value.text) ?? .null,
                "title": doc.title.map(Value.text) ?? .null,
                "role": doc.role.map(Value.text) ?? .null,
                "role_heading": doc.roleHeading.map(Value.text) ?? .null,
                "abstract": doc.abstractText.map(Value.text) ?? .null,
                "platforms": serializePlatforms(doc.platformsJson),
                "declaration": doc.declarationText.map(Value.text) ?? .null,
                // etag/last_modified are persist meta — the upstream HTTP validators
                // (FetchResult.etag/.lastModified) threaded in for the incremental
                // re-crawl. A nil (flat callers with no validators) binds NULL, which
                // the ON CONFLICT `COALESCE($etag, pages.etag)` preserves against any
                // prior value rather than clobbering it.
                "etag": etag.map(Value.text) ?? .null,
                "last_modified": lastModified.map(Value.text) ?? .null,
                "content_hash": .text(rawPayloadHash),  // meta.rawPayloadHash
                "downloaded_at": .text(now),
                "source_type": .text(pageSourceType),
                "language": doc.language.map(Value.text) ?? .null,
                // pages.js: isReleaseNotes == null ? 0 : (… ? 1 : 0)
                "is_release_notes": .integer(pagesReleaseNotesInt(doc.isReleaseNotes)),
                "url_depth": .integer(Int64(pageUrlDepth)),
                // pages.js: $doc_kind = params.docKind ?? params.role ?? null.
                // persist passes docKind = doc.kind, role = doc.role.
                "doc_kind": (doc.kind ?? doc.role).map(Value.text) ?? .null,
                "source_metadata": serializeMetadata(doc.sourceMetadata),
                "min_ios": doc.minIos.map(Value.text) ?? .null,
                "min_macos": doc.minMacos.map(Value.text) ?? .null,
                "min_watchos": doc.minWatchos.map(Value.text) ?? .null,
                "min_tvos": doc.minTvos.map(Value.text) ?? .null,
                "min_visionos": doc.minVisionos.map(Value.text) ?? .null
            ])
    }

    /// The documents-row upsert SQL (verbatim from documents.js upsertDocument), held as a
    /// constant so insertDocumentRow stays within the body-length gate.
    static let documentsUpsertSQL =
        """
                INSERT INTO documents (
                  source_type, key, title, kind, role, role_heading, framework, url, language,
                  abstract_text, declaration_text, headings, platforms_json,
                  min_ios, min_macos, min_watchos, min_tvos, min_visionos,
                  min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
                  is_deprecated, is_beta, is_release_notes, url_depth,
                  source_metadata, content_hash, raw_payload_hash, created_at, updated_at
                )
                VALUES (
                  $source_type, $key, $title, $kind, $role, $role_heading, $framework, $url, $language,
                  $abstract_text, $declaration_text, $headings, $platforms_json,
                  $min_ios, $min_macos, $min_watchos, $min_tvos, $min_visionos,
                  $min_ios_num, $min_macos_num, $min_watchos_num, $min_tvos_num, $min_visionos_num,
                  $is_deprecated, $is_beta, $is_release_notes, $url_depth,
                  $source_metadata, $content_hash, $raw_payload_hash, $now, $now
                )
                ON CONFLICT(key) DO UPDATE SET
                  source_type = COALESCE($source_type, documents.source_type),
                  title = COALESCE($title, documents.title),
                  kind = COALESCE($kind, documents.kind),
                  role = COALESCE($role, documents.role),
                  role_heading = COALESCE($role_heading, documents.role_heading),
                  framework = COALESCE($framework, documents.framework),
                  url = COALESCE($url, documents.url),
                  language = COALESCE($language, documents.language),
                  abstract_text = COALESCE($abstract_text, documents.abstract_text),
                  declaration_text = COALESCE($declaration_text, documents.declaration_text),
                  headings = COALESCE($headings, documents.headings),
                  platforms_json = COALESCE($platforms_json, documents.platforms_json),
                  min_ios = COALESCE($min_ios, documents.min_ios),
                  min_macos = COALESCE($min_macos, documents.min_macos),
                  min_watchos = COALESCE($min_watchos, documents.min_watchos),
                  min_tvos = COALESCE($min_tvos, documents.min_tvos),
                  min_visionos = COALESCE($min_visionos, documents.min_visionos),
                  min_ios_num = COALESCE($min_ios_num, documents.min_ios_num),
                  min_macos_num = COALESCE($min_macos_num, documents.min_macos_num),
                  min_watchos_num = COALESCE($min_watchos_num, documents.min_watchos_num),
                  min_tvos_num = COALESCE($min_tvos_num, documents.min_tvos_num),
                  min_visionos_num = COALESCE($min_visionos_num, documents.min_visionos_num),
                  is_deprecated = COALESCE($is_deprecated, documents.is_deprecated),
                  is_beta = COALESCE($is_beta, documents.is_beta),
                  is_release_notes = COALESCE($is_release_notes, documents.is_release_notes),
                  url_depth = COALESCE($url_depth, documents.url_depth),
                  source_metadata = COALESCE($source_metadata, documents.source_metadata),
                  content_hash = COALESCE($content_hash, documents.content_hash),
                  raw_payload_hash = COALESCE($raw_payload_hash, documents.raw_payload_hash),
                  updated_at = $now
                RETURNING id
        """
    /// Step 2 of `persistNormalized`: the documents-row upsert (database.js
    /// upsertNormalizedDocument → documents.js upsertDocument). Returns the document id.
    private static func insertDocumentRow(
        _ txn: SQLTransaction, _ normalized: NormalizedDoc, contentHash: String,
        rawPayloadHash: String, now: String
    ) throws(DBError) -> Int64 {
        let doc = normalized.document
        // ── 2. documents row ─────────────────────────────────────────────────
        // database.js upsertNormalizedDocument → documents.js upsertDocument
        // with the spread normalized.document + the two hashes. $now → both
        // created_at and updated_at (wall-clock).
        let documentSourceType = coerceSourceType(doc.sourceType)
        let framework = doc.framework ?? deriveFrameworkFromPath(doc.key)
        let title = doc.title ?? doc.key  // documents.js: $title = title ?? key
        let docResult = try txn.run(
            Self.documentsUpsertSQL,
            [
                "source_type": .text(documentSourceType),
                "key": .text(doc.key),
                "title": .text(title),
                "kind": doc.kind.map(Value.text) ?? .null,
                "role": doc.role.map(Value.text) ?? .null,
                "role_heading": doc.roleHeading.map(Value.text) ?? .null,
                "framework": framework.map(Value.text) ?? .null,
                "url": doc.url.map(Value.text) ?? .null,
                "language": doc.language.map(Value.text) ?? .null,
                "abstract_text": doc.abstractText.map(Value.text) ?? .null,
                "declaration_text": doc.declarationText.map(Value.text) ?? .null,
                "headings": doc.headings.map(Value.text) ?? .null,
                "platforms_json": serializePlatforms(doc.platformsJson),
                "min_ios": doc.minIos.map(Value.text) ?? .null,
                "min_macos": doc.minMacos.map(Value.text) ?? .null,
                "min_watchos": doc.minWatchos.map(Value.text) ?? .null,
                "min_tvos": doc.minTvos.map(Value.text) ?? .null,
                "min_visionos": doc.minVisionos.map(Value.text) ?? .null,
                "min_ios_num": encodeVersion(doc.minIos),
                "min_macos_num": encodeVersion(doc.minMacos),
                "min_watchos_num": encodeVersion(doc.minWatchos),
                "min_tvos_num": encodeVersion(doc.minTvos),
                "min_visionos_num": encodeVersion(doc.minVisionos),
                // documents.js: isX == null ? null : (x ? 1 : 0)
                "is_deprecated": boolToValue(doc.isDeprecated),
                "is_beta": boolToValue(doc.isBeta),
                "is_release_notes": boolToValue(doc.isReleaseNotes),
                "url_depth": doc.urlDepth.map { .integer(Int64($0)) } ?? .null,
                "source_metadata": serializeMetadata(doc.sourceMetadata),
                "content_hash": .text(contentHash),
                "raw_payload_hash": .text(rawPayloadHash),
                "now": .text(now)
            ])
        let documentId = docResult.lastInsertRowid
        return documentId
    }
    // MARK: - JS-helper reproductions (bit-for-bit)

    /// `storage/source-types.js` DEFAULT_SOURCE_TYPE.
    static let DEFAULT_SOURCE_TYPE = "apple-docc"

    /// `storage/source-types.js` SOURCE_TYPES — the canonical valid set.
    static let SOURCE_TYPES: Set<String> = [
        "apple-docc", "swift-docc", "external-docc", "apple-archive", "guidelines", "hig",
        "packages", "sample-code", "swift-book", "swift-evolution", "swift-org", "wwdc"
    ]

    /// `storage/source-types.js` ROOT_SOURCE_TYPE_BY_SLUG.
    static let ROOT_SOURCE_TYPE_BY_SLUG: [String: String] = [
        "app-store-review": "guidelines",
        "design": "hig",
        "apple-archive": "apple-archive",
        "packages": "packages",
        "sample-code": "sample-code",
        "swift-book": "swift-book",
        "swift-evolution": "swift-evolution",
        "swift-org": "swift-org",
        "wwdc": "wwdc"
    ]

    /// `coerceSourceType` — valid value passes, anything else → default.
    static func coerceSourceType(_ value: String?) -> String {
        if let value, SOURCE_TYPES.contains(value) { return value }
        return DEFAULT_SOURCE_TYPE
    }

    /// `deriveRootSourceType(slug, kind)` — slug map first, then kind, then default.
    static func deriveRootSourceType(slug: String, kind: String?) -> String {
        if let mapped = ROOT_SOURCE_TYPE_BY_SLUG[slug] { return mapped }
        if kind == "guidelines" { return "guidelines" }
        if kind == "design" { return "hig" }
        return DEFAULT_SOURCE_TYPE
    }

    /// `deriveFrameworkFromPath(path)` — `documentation/<fw>/…` → `<fw>`, else the
    /// first non-empty segment, else nil.
    static func deriveFrameworkFromPath(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        if parts.first == "documentation" { return parts.count > 1 ? parts[1] : nil }
        return parts.first
    }

    /// `serializePlatforms(value)` — null → NULL; a string passes through; a
    /// non-string would be JSON-stringified. normalize emits platformsJson as a
    /// pre-serialized string (or null), so this is a passthrough in practice.
    static func serializePlatforms(_ value: String?) -> Value {
        value.map(Value.text) ?? .null
    }

    /// pages/documents `$source_metadata` rule: null → NULL; string passes
    /// through; (object would be JSON-stringified — normalize only emits null/str).
    static func serializeMetadata(_ value: String?) -> Value {
        value.map(Value.text) ?? .null
    }

    /// `lib/version-encode.js` `encodeVersion` — MAJOR*1e6 + MINOR*1e3 + PATCH, or
    /// NULL for missing/unparseable. Components must be in [0, 1000).
    static func encodeVersion(_ text: String?) -> Value {
        guard let text else { return .null }
        // JS `String(text).trim()` — strip leading/trailing whitespace. Swift's
        // `Character.isWhitespace` is Unicode-aware (a superset of JS's trim set for
        // the digit-and-dot version strings Apple emits), so it matches in practice.
        let trimmed = text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed()
        if trimmed.isEmpty { return .null }
        let trimmedString = String(trimmed)
        // JS: /^\d+(?:\.\d+){0,3}/ — leading run of up to 4 dot-separated integers.
        guard let numeric = leadingVersion(trimmedString) else { return .null }
        let parts = numeric.split(separator: ".").map { Int($0) }
        // Any non-finite / out-of-range component (>= 1000 or < 0) → null.
        guard parts.allSatisfy({ $0 != nil }) else { return .null }
        let ints = parts.compactMap { $0 }
        guard ints.allSatisfy({ $0 >= 0 && $0 < 1000 }) else { return .null }
        let major = ints[0]
        let minor = ints.count > 1 ? ints[1] : 0
        let patch = ints.count > 2 ? ints[2] : 0
        return .integer(Int64(major) * 1_000_000 + Int64(minor) * 1_000 + Int64(patch))
    }

    /// The leading `^\d+(?:\.\d+){0,3}` match of the JS encodeVersion regex.
    /// Returns the matched prefix (e.g. "17.4.1") or nil when the string does not
    /// start with a digit.
    private static func leadingVersion(_ s: String) -> String? {
        var out = ""
        var components = 0  // dot-separated groups consumed beyond the first
        var index = s.startIndex
        // First component: one or more digits.
        var sawFirstDigit = false
        while index < s.endIndex, s[index].isNumber {
            out.append(s[index])
            sawFirstDigit = true
            index = s.index(after: index)
        }
        guard sawFirstDigit else { return nil }
        // Up to 3 further `.\d+` groups.
        while components < 3, index < s.endIndex, s[index] == "." {
            let afterDot = s.index(after: index)
            guard afterDot < s.endIndex, s[afterDot].isNumber else { break }
            out.append(".")
            index = afterDot
            while index < s.endIndex, s[index].isNumber {
                out.append(s[index])
                index = s.index(after: index)
            }
            components += 1
        }
        return out
    }

    /// Dedup a section/relationship batch by a composite `key`, keeping the LAST
    /// occurrence per key (last-wins) — the exact observable result of the JS
    /// `INSERT … ON CONFLICT(<composite>) DO UPDATE SET <non-key cols>` in the
    /// replace path (after a full DELETE, a repeated key UPDATEs the row to the
    /// later values). The comparison is multiset-over-values (ids excluded), so the
    /// surviving element ORDER is irrelevant; only one element per key, with the
    /// final values, must remain. Returns the survivors in first-seen key order
    /// (stable, deterministic). No-op when keys are already unique (the common case).
    static func dedupedLastWins<Element>(
        _ elements: [Element], key: (Element) -> String
    ) -> [Element] {
        // Fast path: all keys unique → return as-is (avoids any allocation churn).
        var seen = Set<String>()
        var hasDuplicate = false
        for element in elements where !seen.insert(key(element)).inserted {
            hasDuplicate = true
            break
        }
        if !hasDuplicate { return elements }

        // Slow path: last-wins. Walk once, recording each key's latest element and
        // its first-seen position; emit in first-seen order with the latest value.
        var latest: [String: Element] = [:]
        var order: [String] = []
        for element in elements {
            let elementKey = key(element)
            if latest[elementKey] == nil { order.append(elementKey) }
            latest[elementKey] = element
        }
        return order.compactMap { latest[$0] }
    }

    /// documents.js boolean rule: `x == null ? null : (x ? 1 : 0)`.
    static func boolToValue(_ value: Bool?) -> Value {
        guard let value else { return .null }
        return .integer(value ? 1 : 0)
    }

    /// pages.js `is_release_notes` rule: `x == null ? 0 : (x ? 1 : 0)` — nil maps to
    /// 0 (the pages column is bound an integer, never NULL).
    static func pagesReleaseNotesInt(_ value: Bool?) -> Int64 {
        guard let value else { return 0 }
        return value ? 1 : 0
    }

    /// Read a TEXT cell as `String?` (any non-text / NULL → nil) — the `pageValidator`
    /// projection's unwrap, mirroring IndexEmbeddings' cell reader.
    static func cellText(_ value: Value?) -> String? {
        if case .text(let text) = value { return text }
        return nil
    }
}
