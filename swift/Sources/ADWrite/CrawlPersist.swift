// CrawlPersist — the native apple-docs crawl PERSIST on REAL SQLite (the storage
// pivot: the corpus format is the JS `bun:sqlite` format again). The row-writing
// heart of the storage writer: it mirrors the Bun persist
// (apple-docs/src/pipeline/persist.js + src/storage/repos/*) statement for
// statement — every INSERT/UPDATE below is the LITERAL JS SQL text (same column
// set, same `ON CONFLICT … DO UPDATE`, same `$name` placeholders), including the
// composite conflict targets and the correlated page-count UPDATE that the
// interim ADDB engine could not express.
//
// Two deliberate departures from the per-statement JS shape, both
// semantics-preserving (kept from the ADDB era on their own merits):
//   • `seedCrawlBatch` — a page's many same-root ref seeds commit in ONE
//     transaction instead of one autocommit each (the crawl's dominant serial-
//     write cost); the probe + first-wins intra-batch dedup reproduces the JS
//     per-ref `seedCrawlIfNew` loop's row outcomes exactly.
//   • `getPendingCrawlAny` — the JS has no cross-root pull; this one carries the
//     RFC 0007 §11 finding #2 fix (the `root_slug IN (…)` scoping filter) so one
//     source's crawl can never drain a different source's leftover backlog.
//     `ensureCrawlStatusIndex` (a status index over the frontier) is its perf
//     companion, created at crawl time, never by the schema ladder.
//
// Derived values reproduce the JS helpers bit-for-bit: serializePlatforms
// (documents.js), encodeVersion (lib/version-encode.js), coerceSourceType /
// deriveRootSourceType (storage/source-types.js), deriveFrameworkFromPath
// (repos/documents.js), url_depth (the facade upsertPage).
//
// Content codec: the persist writes document_sections.content_text/content_json
// as PLAIN TEXT (the zstd section codec is compact/snapshot-only). content_text
// is NOT NULL, so a nil normalized contentText stores '' (the JS `?? ''`).
//
// Wall-clock columns (`first_seen`/`last_seen`, `downloaded_at`/`converted_at`,
// `created_at`/`updated_at`) bind a caller-supplied ISO-8601 `now` (the JS binds
// `new Date().toISOString()`).

// swiftlint:disable file_length  // the statement-for-statement JS persist port is legitimately long

public import ADStorage

/// The native crawl persist. A namespace of pure write functions over an open,
/// writable SQLite connection whose schema is already at `AppleDocsSchema`.
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
    /// (INSERT … ON CONFLICT(slug) DO UPDATE … RETURNING id — an autocommit
    /// statement, as in the JS). Derives `source_type` via
    /// `deriveRootSourceType(slug, kind)` when `sourceType` is nil, exactly as the
    /// JS does. `first_seen`/`last_seen` are bound to `now` (wall-clock).
    ///
    /// - Returns: the root's `id` — fresh on insert, the existing id on a
    ///   conflicting update (the RETURNING row carries both branches).
    @discardableResult
    public static func upsertRoot(
        _ db: SQLiteWriteConnection, slug: String, displayName: String, kind: String, source: String,
        seedPath: String? = nil, sourceType: String? = nil, now: String
    ) throws(SQLiteWriteError) -> Int64 {
        let resolvedSourceType = sourceType ?? deriveRootSourceType(slug: slug, kind: kind)
        let row = try db.get(
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
                "seed_path": seedPath.map(SQLiteValue.text) ?? .null,
                "source_type": .text(resolvedSourceType),
                "now": .text(now)
            ])
        return row?.int("id") ?? 0
    }

    /// Recompute `roots.page_count` for one root — the JS `repos/roots.js`
    /// `updateRootPageCount`'s single correlated UPDATE, restored now that the
    /// engine runs it (the ADDB era had to split it into a SELECT + plain UPDATE).
    /// Keyed by `id` rather than the JS's `slug` because every native caller holds
    /// the rootId; the correlated subquery is identical.
    public static func refreshRootPageCount(_ db: SQLiteWriteConnection, rootId: Int64) throws(SQLiteWriteError) {
        try db.run(
            "UPDATE roots SET page_count = (SELECT COUNT(*) FROM pages WHERE root_id = roots.id "
                + "AND status = 'active') WHERE id = $id",
            ["id": .integer(rootId)])
    }

    // MARK: - reads

    /// The HTTP validators (`etag` / `last_modified`) stored for the page at `path`, or `nil` when no
    /// page row exists. The incremental re-crawl reads this back BEFORE fetching and feeds the `etag`
    /// into the adapter's conditional `check` (`If-None-Match`), so an unchanged upstream resource is
    /// skipped without re-downloading.
    public static func pageValidator(
        _ db: SQLiteWriteConnection, path: String
    ) throws(SQLiteWriteError) -> (etag: String?, lastModified: String?)? {
        guard
            let row = try db.get(
                "SELECT etag, last_modified FROM pages WHERE path = $path", ["path": .text(path)])
        else { return nil }
        return (etag: row.text("etag"), lastModified: row.text("last_modified"))
    }

    // MARK: - crawl_state work-queue (BFS)
    //
    // The reference-following crawl's frontier: one row per discovered path (pending → processed /
    // failed), keyed by path with the seeding root_slug + BFS depth. Ports src/storage/repos/crawl.js
    // so a native crawl's queue is byte-identical to the JS crawler's.

    /// Upsert a crawl_state row (JS `setCrawlState`, verbatim): set the path's `status` + `error`.
    /// `ON CONFLICT(path)` touches only status/error, so re-marking a path keeps its original
    /// `root_slug`/`depth`.
    public static func setCrawlState(
        _ db: SQLiteWriteConnection, path: String, status: String, rootSlug: String, depth: Int = 0,
        error: String? = nil
    ) throws(SQLiteWriteError) {
        try db.run(
            """
            INSERT INTO crawl_state (path, status, root_slug, depth, error)
            VALUES ($path, $status, $root_slug, $depth, $error)
            ON CONFLICT(path) DO UPDATE SET status = $status, error = $error
            """,
            [
                "path": .text(path), "status": .text(status), "root_slug": .text(rootSlug),
                "depth": .integer(Int64(depth)), "error": error.map(SQLiteValue.text) ?? .null
            ])
    }

    /// Bulk-mark a batch of already-tracked paths `processed` in ONE `UPDATE` — one statement for the
    /// whole batch instead of one per path (the batch width is the crawl's window, far below SQLite's
    /// bound-parameter cap). Clears any prior error. Paths must already exist (seeded `pending`).
    public static func markCrawlProcessed(_ db: SQLiteWriteConnection, paths: [String]) throws(SQLiteWriteError) {
        guard !paths.isEmpty else { return }
        var placeholders: [String] = []
        placeholders.reserveCapacity(paths.count)
        var params: [String: SQLiteValue] = [:]
        for (index, path) in paths.enumerated() {
            placeholders.append("$p\(index)")
            params["p\(index)"] = .text(path)
        }
        let sql =
            "UPDATE crawl_state SET status = 'processed', error = NULL WHERE path IN ("
            + placeholders.joined(separator: ", ") + ")"
        try db.run(sql, params)
    }

    /// One-time (idempotent): index `crawl_state.status` so the frontier pull (`WHERE status='pending'`)
    /// is an index seek rather than a scan past an ever-growing pile of `processed` rows. A native-only
    /// perf index created at CRAWL time (never by the schema ladder — the migrated catalog stays
    /// byte-identical to the JS reference).
    public static func ensureCrawlStatusIndex(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("CREATE INDEX IF NOT EXISTS idx_crawl_state_status ON crawl_state(status)")
    }

    /// Seed a path as `pending` only if not already tracked (JS `seedCrawlIfNew`: an existence probe,
    /// then `setCrawlState(path, 'pending', …)`), so re-discovering a path never resets a
    /// `processed`/`failed` row. Returns `true` when a new row was inserted.
    @discardableResult
    public static func seedCrawlIfNew(
        _ db: SQLiteWriteConnection, path: String, rootSlug: String, depth: Int = 0
    ) throws(SQLiteWriteError) -> Bool {
        let existing = try db.get("SELECT 1 FROM crawl_state WHERE path = $path", ["path": .text(path)])
        guard existing == nil else { return false }
        try setCrawlState(db, path: path, status: "pending", rootSlug: rootSlug, depth: depth)
        return true
    }

    /// Batched `seedCrawlIfNew`: probe every ref, then seed all genuinely-new ones in ONE transaction
    /// instead of one autocommit per ref (a reference-following page seeds dozens of same-root refs; the
    /// per-ref commit was the crawl's dominant serial-write cost). The probes stay per-path — an index
    /// seek on the unique `path`. Intra-batch duplicate paths are de-duplicated first-wins, matching the
    /// per-ref loop where the second `seedCrawlIfNew` for a path finds the first's freshly-committed row
    /// and skips. Returns the count newly seeded.
    @discardableResult
    public static func seedCrawlBatch(
        _ db: SQLiteWriteConnection, _ seeds: [(path: String, rootSlug: String, depth: Int)]
    ) throws(SQLiteWriteError) -> Int {
        guard !seeds.isEmpty else { return 0 }
        var seen: Set<String> = []
        var fresh: [(path: String, rootSlug: String, depth: Int)] = []
        for seed in seeds where seen.insert(seed.path).inserted {
            let existing = try db.get(
                "SELECT 1 FROM crawl_state WHERE path = $path", ["path": .text(seed.path)])
            if existing == nil { fresh.append(seed) }
        }
        guard !fresh.isEmpty else { return 0 }
        try db.transaction { () throws(SQLiteWriteError) in
            for seed in fresh {
                try setCrawlState(db, path: seed.path, status: "pending", rootSlug: seed.rootSlug, depth: seed.depth)
            }
        }
        return fresh.count
    }

    /// The next batch of `pending` paths for a root (JS `getPendingCrawl`): `(path, depth)`, up to `limit`.
    public static func getPendingCrawl(
        _ db: SQLiteWriteConnection, rootSlug: String, limit: Int = 10
    ) throws(SQLiteWriteError) -> [(path: String, depth: Int)] {
        let rows = try db.all(
            "SELECT path, depth FROM crawl_state WHERE status = 'pending' AND root_slug = $slug LIMIT $limit",
            ["slug": .text(rootSlug), "limit": .integer(Int64(Swift.max(0, limit)))])
        return rows.compactMap { row in
            guard let path = row.text("path") else { return nil }
            return (path: path, depth: Int(row.int("depth") ?? 0))
        }
    }

    /// The next `limit` `pending` rows across every root in `rootSlugs`, each carrying its stored
    /// `root_slug`. Feeds a cross-root BFS frontier: pooling every root THIS CALL OWNS into one wave keeps
    /// the fetch fan-out saturated even when individual roots have narrow early levels — the JS
    /// shared-semaphore crawl (`discover.js`, one pool across roots) rather than root-at-a-time.
    ///
    /// `rootSlugs` is the hard boundary that keeps one source's `crawl()` call from ever draining a
    /// DIFFERENT source's leftover backlog (RFC 0007 §11 finding #2): before this filter existed, an
    /// interrupted source's `pending` rows got vacuumed up by whichever `.crawl`-mode source ran next and
    /// mis-stamped `pages.root_id` via that caller's `rootIds[f.rootSlug] ?? rootId` fallback. Scoping the
    /// pull to `rootSlugs` (the caller's own root set) makes that fallback unreachable for foreign rows.
    /// An empty `rootSlugs` short-circuits to no rows rather than degrading to the old unfiltered (and now
    /// unsafe) behavior.
    public static func getPendingCrawlAny(
        _ db: SQLiteWriteConnection, rootSlugs: Set<String>, limit: Int = 10
    ) throws(SQLiteWriteError) -> [(path: String, rootSlug: String, depth: Int)] {
        guard !rootSlugs.isEmpty else { return [] }
        var placeholders: [String] = []
        placeholders.reserveCapacity(rootSlugs.count)
        var params: [String: SQLiteValue] = [:]
        for (index, slug) in rootSlugs.enumerated() {
            placeholders.append("$s\(index)")
            params["s\(index)"] = .text(slug)
        }
        params["limit"] = .integer(Int64(Swift.max(0, limit)))
        let sql =
            "SELECT path, root_slug, depth FROM crawl_state WHERE status = 'pending' AND root_slug IN ("
            + placeholders.joined(separator: ", ") + ") LIMIT $limit"
        let rows = try db.all(sql, params)
        return rows.compactMap { row in
            guard let path = row.text("path"), let slug = row.text("root_slug") else { return nil }
            return (path: path, rootSlug: slug, depth: Int(row.int("depth") ?? 0))
        }
    }

    /// The `(pending, processed, failed)` counts for a root (JS `getCrawlStats`).
    public static func getCrawlStats(
        _ db: SQLiteWriteConnection, rootSlug: String
    ) throws(SQLiteWriteError) -> (pending: Int, processed: Int, failed: Int) {
        let rows = try db.all(
            "SELECT status, COUNT(*) AS count FROM crawl_state WHERE root_slug = $slug GROUP BY status",
            ["slug": .text(rootSlug)])
        var pending = 0
        var processed = 0
        var failed = 0
        for row in rows {
            let count = Int(row.int("count") ?? 0)
            switch row.text("status") {
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
    /// `persistNormalizedPage`'s transactional body. In ONE transaction (the JS
    /// `db.tx`, BEGIN IMMEDIATE):
    ///   1. the pages row (`upsertPage` with skipDocumentSync — pages.js
    ///      `upsertPageRow`),
    ///   2. the documents row (`upsertNormalizedDocument` → documents.js
    ///      `upsertDocument`),
    ///   3. replace document_sections (documents.js `replaceSections`: DELETE-all,
    ///      then per-section `INSERT … ON CONFLICT(document_id, section_kind,
    ///      sort_order) DO UPDATE` — the literal composite upsert, restored),
    ///   4. replace document_relationships (documents.js `replaceRelationships`,
    ///      same composite-upsert shape on (from_key, to_key, relation_type)),
    ///   5. markConverted (pages.js — sets converted_at).
    ///
    /// `contentHash`/`rawPayloadHash` flow into both the pages content_hash and the
    /// documents content_hash/raw_payload_hash columns, exactly as the JS persist
    /// threads them. `etag`/`lastModified` are the upstream HTTP validators; a `nil`
    /// is COALESCE-preserved against any existing row value, never overwriting it.
    public static func persistNormalized(
        _ db: SQLiteWriteConnection, rootId: Int64, path: String, _ normalized: NormalizedDoc,
        hashes: DocumentHashes, etag: String? = nil, lastModified: String? = nil, now: String
    ) throws(SQLiteWriteError) {
        let doc = normalized.document
        try db.transaction { () throws(SQLiteWriteError) in
            try insertPageRow(
                db, rootId: rootId, path: path, normalized, rawPayloadHash: hashes.rawPayload,
                etag: etag, lastModified: lastModified, now: now)

            let documentId = try insertDocumentRow(
                db, normalized, contentHash: hashes.content, rawPayloadHash: hashes.rawPayload, now: now)

            // ── 3. replace document_sections (documents.js replaceSections) ─────
            try db.run(
                "DELETE FROM document_sections WHERE document_id = $document_id",
                ["document_id": .integer(documentId)])
            for section in normalized.sections {
                try db.run(
                    """
                    INSERT INTO document_sections (document_id, section_kind, heading, content_text, content_json, sort_order)
                    VALUES ($document_id, $section_kind, $heading, $content_text, $content_json, $sort_order)
                    ON CONFLICT(document_id, section_kind, sort_order) DO UPDATE SET
                      heading = $heading,
                      content_text = $content_text,
                      content_json = $content_json
                    """,
                    [
                        "document_id": .integer(documentId),
                        "section_kind": .text(section.sectionKind),
                        "heading": section.heading.map(SQLiteValue.text) ?? .null,
                        // content_text is NOT NULL; null normalized text → '' (JS `?? ''`).
                        // Plain TEXT — the zstd codec is compact/snapshot-only.
                        "content_text": .text(section.contentText ?? ""),
                        "content_json": section.contentJson.map(SQLiteValue.text) ?? .null,
                        "sort_order": .integer(Int64(section.sortOrder))
                    ])
            }

            // ── 4. replace document_relationships (documents.js replaceRelationships,
            // fromKey = normalized.document.key; each relationship's own fromKey
            // falls back to it) ──────────────────────────────────────────────────
            try db.run(
                "DELETE FROM document_relationships WHERE from_key = $from_key",
                ["from_key": .text(doc.key)])
            for relationship in normalized.relationships {
                try db.run(
                    """
                    INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
                    VALUES ($from_key, $to_key, $relation_type, $section, $sort_order)
                    ON CONFLICT(from_key, to_key, relation_type) DO UPDATE SET
                      section = $section,
                      sort_order = $sort_order
                    """,
                    [
                        "from_key": .text(relationship.fromKey ?? doc.key),
                        "to_key": .text(relationship.toKey),
                        "relation_type": .text(relationship.relationType),
                        "section": relationship.section.map(SQLiteValue.text) ?? .null,
                        "sort_order": .integer(Int64(relationship.sortOrder ?? 0))
                    ])
            }

            // ── 5. markConverted (pages.js: UPDATE pages SET converted_at) ──────
            try db.run(
                "UPDATE pages SET converted_at = $converted_at WHERE path = $path",
                ["converted_at": .text(now), "path": .text(path)])
        }
    }
}

// Bit-for-bit reproductions of the JS persist helpers (source-type coercion, framework derivation,
// platform/metadata serialization, version encoding). Split from the enum body to stay within the
// size/complexity gate; each mirrors its cited JS function exactly.
extension CrawlPersist {
    /// Step 1 of `persistNormalized`: the pages-row upsert (pages.js upsertPageRow, verbatim).
    private static func insertPageRow(
        _ db: SQLiteWriteConnection, rootId: Int64, path: String, _ normalized: NormalizedDoc,
        rawPayloadHash: String, etag: String? = nil, lastModified: String? = nil, now: String
    ) throws(SQLiteWriteError) {
        let doc = normalized.document
        // persist.js upsertPageFromDocument → db.upsertPage. The facade derives
        // source_type (doc.sourceType ?? fallback ?? root.source_type ?? default)
        // and url_depth (doc.urlDepth ?? max(0, path.split('/').len-1)). For the
        // normalized path the doc carries both, so we use them directly.
        let pageSourceType = doc.sourceType ?? DEFAULT_SOURCE_TYPE
        let pageUrlDepth = doc.urlDepth ?? max(0, path.split(separator: "/", omittingEmptySubsequences: true).count - 1)
        try db.run(
            Self.pagesUpsertSQL,
            [
                "root_id": .integer(rootId),
                // persist.js: url = doc.url ?? defaultUrl ?? null. For the
                // normalized path defaultUrl is unset (sourceTypeFallback path),
                // so url is doc.url (always set by normalize) or null.
                "path": .text(path),
                "url": doc.url.map(SQLiteValue.text) ?? .null,
                "title": doc.title.map(SQLiteValue.text) ?? .null,
                "role": doc.role.map(SQLiteValue.text) ?? .null,
                "role_heading": doc.roleHeading.map(SQLiteValue.text) ?? .null,
                "abstract": doc.abstractText.map(SQLiteValue.text) ?? .null,
                "platforms": serializePlatforms(doc.platformsJson),
                "declaration": doc.declarationText.map(SQLiteValue.text) ?? .null,
                // etag/last_modified are persist meta — the upstream HTTP validators
                // threaded in for the incremental re-crawl. A nil (flat callers with
                // no validators) binds NULL, which the ON CONFLICT `COALESCE($etag,
                // pages.etag)` preserves against any prior value.
                "etag": etag.map(SQLiteValue.text) ?? .null,
                "last_modified": lastModified.map(SQLiteValue.text) ?? .null,
                "content_hash": .text(rawPayloadHash),  // meta.rawPayloadHash
                "downloaded_at": .text(now),
                "source_type": .text(pageSourceType),
                "language": doc.language.map(SQLiteValue.text) ?? .null,
                // pages.js: isReleaseNotes == null ? 0 : (… ? 1 : 0)
                "is_release_notes": .integer(pagesReleaseNotesInt(doc.isReleaseNotes)),
                "url_depth": .integer(Int64(pageUrlDepth)),
                // pages.js: $doc_kind = params.docKind ?? params.role ?? null.
                // persist passes docKind = doc.kind, role = doc.role.
                "doc_kind": (doc.kind ?? doc.role).map(SQLiteValue.text) ?? .null,
                "source_metadata": serializeMetadata(doc.sourceMetadata),
                "min_ios": doc.minIos.map(SQLiteValue.text) ?? .null,
                "min_macos": doc.minMacos.map(SQLiteValue.text) ?? .null,
                "min_watchos": doc.minWatchos.map(SQLiteValue.text) ?? .null,
                "min_tvos": doc.minTvos.map(SQLiteValue.text) ?? .null,
                "min_visionos": doc.minVisionos.map(SQLiteValue.text) ?? .null
            ])
    }

    /// The pages-row upsert SQL (verbatim from pages.js `upsertPageRow`), held as a
    /// constant so `insertPageRow` stays within the body-length gate. (The JS reads
    /// the RETURNING row; the native persist has no use for the page id, so the row
    /// is stepped over.)
    static let pagesUpsertSQL = """
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
        RETURNING id
        """

    /// The documents-row upsert SQL (verbatim from documents.js upsertDocument), held as a
    /// constant so insertDocumentRow stays within the body-length gate.
    static let documentsUpsertSQL = """
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
        _ db: SQLiteWriteConnection, _ normalized: NormalizedDoc, contentHash: String,
        rawPayloadHash: String, now: String
    ) throws(SQLiteWriteError) -> Int64 {
        let doc = normalized.document
        let documentSourceType = coerceSourceType(doc.sourceType)
        let framework = doc.framework ?? deriveFrameworkFromPath(doc.key)
        let title = doc.title ?? doc.key  // documents.js: $title = title ?? key
        let row = try db.get(
            Self.documentsUpsertSQL,
            [
                "source_type": .text(documentSourceType),
                "key": .text(doc.key),
                "title": .text(title),
                "kind": doc.kind.map(SQLiteValue.text) ?? .null,
                "role": doc.role.map(SQLiteValue.text) ?? .null,
                "role_heading": doc.roleHeading.map(SQLiteValue.text) ?? .null,
                "framework": framework.map(SQLiteValue.text) ?? .null,
                "url": doc.url.map(SQLiteValue.text) ?? .null,
                "language": doc.language.map(SQLiteValue.text) ?? .null,
                "abstract_text": doc.abstractText.map(SQLiteValue.text) ?? .null,
                "declaration_text": doc.declarationText.map(SQLiteValue.text) ?? .null,
                "headings": doc.headings.map(SQLiteValue.text) ?? .null,
                "platforms_json": serializePlatforms(doc.platformsJson),
                "min_ios": doc.minIos.map(SQLiteValue.text) ?? .null,
                "min_macos": doc.minMacos.map(SQLiteValue.text) ?? .null,
                "min_watchos": doc.minWatchos.map(SQLiteValue.text) ?? .null,
                "min_tvos": doc.minTvos.map(SQLiteValue.text) ?? .null,
                "min_visionos": doc.minVisionos.map(SQLiteValue.text) ?? .null,
                "min_ios_num": encodeVersion(doc.minIos),
                "min_macos_num": encodeVersion(doc.minMacos),
                "min_watchos_num": encodeVersion(doc.minWatchos),
                "min_tvos_num": encodeVersion(doc.minTvos),
                "min_visionos_num": encodeVersion(doc.minVisionos),
                // documents.js: isX == null ? null : (x ? 1 : 0)
                "is_deprecated": boolToValue(doc.isDeprecated),
                "is_beta": boolToValue(doc.isBeta),
                "is_release_notes": boolToValue(doc.isReleaseNotes),
                "url_depth": doc.urlDepth.map { SQLiteValue.integer(Int64($0)) } ?? .null,
                "source_metadata": serializeMetadata(doc.sourceMetadata),
                "content_hash": .text(contentHash),
                "raw_payload_hash": .text(rawPayloadHash),
                "now": .text(now)
            ])
        return row?.int("id") ?? 0
    }

    // MARK: - JS-helper reproductions (bit-for-bit)

    /// `storage/source-types.js` DEFAULT_SOURCE_TYPE.
    static let DEFAULT_SOURCE_TYPE = "apple-docc"

    /// `storage/source-types.js` SOURCE_TYPES — the canonical valid set.
    static let SOURCE_TYPES: Set<String> = [
        "apple-docc", "swift-docc", "external-docc", "apple-archive", "guidelines", "hig",
        "packages", "sample-code", "swift-book", "swift-evolution", "swift-org", "wwdc"
    ]

    /// `storage/source-types.js` ROOT_SOURCE_TYPE_BY_SLUG — as ORDERED entries (a JS
    /// `Map`, iterated in insertion order by the v7 backfill migration).
    static let ROOT_SOURCE_TYPE_ENTRIES: [(slug: String, sourceType: String)] = [
        ("app-store-review", "guidelines"),
        ("design", "hig"),
        ("apple-archive", "apple-archive"),
        ("packages", "packages"),
        ("sample-code", "sample-code"),
        ("swift-book", "swift-book"),
        ("swift-evolution", "swift-evolution"),
        ("swift-org", "swift-org"),
        ("wwdc", "wwdc")
    ]

    /// `coerceSourceType` — valid value passes, anything else → default.
    static func coerceSourceType(_ value: String?) -> String {
        if let value, SOURCE_TYPES.contains(value) { return value }
        return DEFAULT_SOURCE_TYPE
    }

    /// `deriveRootSourceType(slug, kind)` — slug map first, then kind, then default.
    static func deriveRootSourceType(slug: String, kind: String?) -> String {
        if let mapped = ROOT_SOURCE_TYPE_ENTRIES.first(where: { $0.slug == slug })?.sourceType {
            return mapped
        }
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
    static func serializePlatforms(_ value: String?) -> SQLiteValue {
        value.map(SQLiteValue.text) ?? .null
    }

    /// pages/documents `$source_metadata` rule: null → NULL; string passes
    /// through; (object would be JSON-stringified — normalize only emits null/str).
    static func serializeMetadata(_ value: String?) -> SQLiteValue {
        value.map(SQLiteValue.text) ?? .null
    }

    /// `lib/version-encode.js` `encodeVersion` — MAJOR*1e6 + MINOR*1e3 + PATCH, or
    /// NULL for missing/unparseable. Components must be in [0, 1000).
    static func encodeVersion(_ text: String?) -> SQLiteValue {
        encodeVersionNumber(text).map(SQLiteValue.integer) ?? .null
    }

    /// The numeric core of ``encodeVersion(_:)`` — nil for missing/unparseable.
    static func encodeVersionNumber(_ text: String?) -> Int64? {
        guard let text else { return nil }
        // JS `String(text).trim()` — strip leading/trailing whitespace. Swift's
        // `Character.isWhitespace` is Unicode-aware (a superset of JS's trim set for
        // the digit-and-dot version strings Apple emits), so it matches in practice.
        let trimmed = text.drop(while: \.isWhitespace).reversed().drop(while: \.isWhitespace).reversed()
        if trimmed.isEmpty { return nil }
        let trimmedString = String(trimmed)
        // JS: /^\d+(?:\.\d+){0,3}/ — leading run of up to 4 dot-separated integers.
        guard let numeric = leadingVersion(trimmedString) else { return nil }
        let parts = numeric.split(separator: ".").map { Int($0) }
        // Any non-finite / out-of-range component (>= 1000 or < 0) → null.
        guard parts.allSatisfy({ $0 != nil }) else { return nil }
        let ints = parts.compactMap { $0 }
        guard ints.allSatisfy({ $0 >= 0 && $0 < 1000 }) else { return nil }
        let major = ints[0]
        let minor = ints.count > 1 ? ints[1] : 0
        let patch = ints.count > 2 ? ints[2] : 0
        return Int64(major) * 1_000_000 + Int64(minor) * 1_000 + Int64(patch)
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

    /// documents.js boolean rule: `x == null ? null : (x ? 1 : 0)`.
    static func boolToValue(_ value: Bool?) -> SQLiteValue {
        guard let value else { return .null }
        return .integer(value ? 1 : 0)
    }

    /// pages.js `is_release_notes` rule: `x == null ? 0 : (x ? 1 : 0)` — nil maps to
    /// 0 (the pages column is bound an integer, never NULL).
    static func pagesReleaseNotesInt(_ value: Bool?) -> Int64 {
        guard let value else { return 0 }
        return value ? 1 : 0
    }
}
