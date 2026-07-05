// RepairPageRootIds — the one-time `pages.root_id` repair for a corpus written by the pre-fix
// `CrawlDriver` (RFC 0007 §11 finding #2: `getPendingCrawlAny` used to pull a DIFFERENT source's
// leftover `pending` `crawl_state` backlog with no root/source filter, and the caller mis-attributed
// it via its own `rootIds[f.rootSlug] ?? rootId` persist fallback — stamping the WRONG source's
// default root onto that page's first-ever persist). `CrawlPersist.getPendingCrawlAny` is now scoped
// to the calling crawl's own root set going FORWARD; this repairs a corpus that already has the wrong
// `pages.root_id` baked in from before that fix.
//
// ── Ground truth (both immune to the bug — set from the crawl-key/path STRING, never from the
//    `rootIds` fallback) ──────────────────────────────────────────────────────────────────────────
//   • `crawl_state.root_slug`, correlated to a page via `documents.key == crawl_state.path`. Only
//     `.crawl`-mode sources (hig, apple-docc, swift-docc) have crawl_state rows at all.
//   • `documents.framework`, correlated to a page via `documents.url == pages.path`. Present for
//     every source, `.crawl`-mode or flat — the only signal available for a flat source (which has
//     no crawl_state rows whatsoever).
//
// IMPORTANT — corrects an assumption from the original bug write-up: `pages.path` is NOT the same
// string as `crawl_state.path` / `documents.key`. Verified directly against the real corpus (a
// throwaway read-only diagnostic probe, since deleted): for a `design` page, `pages.path` and
// `documents.url` are BOTH the external URL
// (`https://developer.apple.com/design/human-interface-guidelines`), while `documents.key` and
// `crawl_state.path` are BOTH the bare crawl key (`design/human-interface-guidelines`) — the two
// pairs never overlap. So the correlation goes THROUGH `documents` as the hub: `pages.path ==
// documents.url` gets you to a `documents` row, whose `key` then looks up `crawl_state.root_slug`
// (if any exists), with `documents.framework` itself as the fallback when there's no crawl_state row.
//
// ── Why this is an application-level loop, not a JOIN or a correlated UPDATE ────────────────────────
// ADDB's planner can't express a single correlated `UPDATE … FROM (SELECT …)` (the same derived-table
// gap `ADStorage/Frameworks.swift` and `refreshRootPageCount` below already route around) — and
// separately, a live SQL JOIN of `pages`/`documents` at this corpus's scale (~342K rows a side) was
// measured against the real corpus to not complete in a reasonable time (no efficient join strategy
// for this predicate at this size), independently confirming the join must stay application-level.
// So `run` reads `roots` / `crawl_state` / `documents` / `pages` in four plain bulk SELECTs (small
// enough at corpus scale to hold in memory at once — tens of MB, not GBs — matching
// `IndexEmbeddings.run`'s own "read everything, then batch the writes" precedent), resolves each
// active page's correct root id via plain Swift dictionary lookups, and writes only the pages whose
// stored `root_id` actually disagrees.
//
// ── Why the writes are batched `UPDATE … WHERE path IN (…)`, grouped by target root ────────────────
// ADDB collects an UPDATE's matching rows by a FULL TABLE SCAN regardless of the WHERE clause's
// selectivity (the same `Writer.collectMatches` cost `CrawlPersist.markCrawlProcessed`'s own doc
// comment describes for `crawl_state`) — so one `UPDATE … WHERE path = ?` per changed page would each
// rescan the whole `pages` table: O(changed × total). Batching many paths into one `path IN (…)`
// amortizes that scan over the whole batch, exactly `markCrawlProcessed`'s established pattern —
// grouped by TARGET root id here (rather than one uniform value) since different pages resolve to
// different roots and a single UPDATE can only set one new value.
//
// Pure ADWrite persistence logic (a namespace of plain read/resolve/write functions over an open
// `Database`, `throws(DBError)` like the rest of this file's siblings), so it is unit-testable via
// `ADWriteTests` with no ArgumentParser/CLI dependency — `ad-cli _repair-page-root-ids`
// (`ADCLI/RepairPageRootIdsSpike.swift`) is a thin wrapper that opens the db, calls `run`, and prints
// the result (matching `BackfillPageCountSpikeCommand`'s own thin-wrapper-over-`CrawlPersist` shape).

public import ADDB
public import ADSQLModel

public enum RepairPageRootIds {
    /// The repair pass's outcome counts.
    public struct Result: Sendable, Equatable {
        /// Active pages read from `pages`.
        public var examined = 0
        /// Pages whose `root_id` was updated to the resolved value.
        public var changed = 0
        /// Pages whose stored `root_id` already matched the resolved value (no write issued).
        public var alreadyCorrect = 0
        /// Pages that couldn't be resolved to any root (no matching `documents` row, no crawl_state/
        /// framework slug, or the resolved slug matches no known root) — left untouched, never guessed.
        public var unresolved = 0
        /// Up to 5 example unresolved paths, for operator visibility.
        public var unresolvedSamples: [String] = []
        public init() {}
    }

    /// One `documents` row's correlation payload — just enough to resolve a page's correct root.
    struct DocumentInfo {
        let key: String
        let framework: String?
    }

    /// One `pages` row's repair-relevant projection.
    struct PageRow {
        let path: String
        let rootId: Int64
    }

    /// Re-derives `pages.root_id` for every ACTIVE page from ground truth immune to the RFC 0007 §11
    /// finding #2 mis-attribution (`crawl_state.root_slug`, else `documents.framework`). `batchSize`
    /// (clamped to at least 1) bounds each `UPDATE … WHERE path IN (…)` statement's placeholder count.
    public static func run(_ db: Database, batchSize: Int) throws(DBError) -> Result {
        let rootIdBySlug = try loadRootIdBySlug(db)
        let crawlStateSlugByKey = try loadCrawlStateSlugByKey(db)
        let documentByUrl = try loadDocumentByUrl(db)
        let pages = try loadActivePages(db)

        var result = Result()
        result.examined = pages.count
        var updates: [(path: String, rootId: Int64)] = []
        updates.reserveCapacity(pages.count)

        for page in pages {
            guard
                let desiredRootId = resolveDesiredRootId(
                    path: page.path, documentByUrl: documentByUrl, crawlStateSlugByKey: crawlStateSlugByKey,
                    rootIdBySlug: rootIdBySlug)
            else {
                result.unresolved += 1
                if result.unresolvedSamples.count < 5 { result.unresolvedSamples.append(page.path) }
                continue
            }
            if desiredRootId == page.rootId {
                result.alreadyCorrect += 1
            } else {
                updates.append((path: page.path, rootId: desiredRootId))
            }
        }
        result.changed = updates.count

        try applyRootIdUpdates(db, updates: updates, batchSize: Swift.max(1, batchSize))
        return result
    }

    // MARK: - reads (four plain bulk SELECTs — see the file header for why no JOIN)

    /// `roots`: slug -> id (small, ~406 rows at this corpus's scale).
    private static func loadRootIdBySlug(_ db: Database) throws(DBError) -> [String: Int64] {
        let rows = try db.prepare("SELECT id, slug FROM roots").all([:])
        var out: [String: Int64] = [:]
        out.reserveCapacity(rows.count)
        for row in rows {
            guard case .integer(let id)? = row["id"], case .text(let slug)? = row["slug"] else { continue }
            out[slug] = id
        }
        return out
    }

    /// `crawl_state`: path (== `documents.key`) -> root_slug. Only `.crawl`-mode sources have any rows
    /// here; a flat source's pages resolve via `documents.framework` alone (this map simply misses).
    private static func loadCrawlStateSlugByKey(_ db: Database) throws(DBError) -> [String: String] {
        let rows = try db.prepare("SELECT path, root_slug FROM crawl_state").all([:])
        var out: [String: String] = [:]
        out.reserveCapacity(rows.count)
        for row in rows {
            guard case .text(let path)? = row["path"], case .text(let slug)? = row["root_slug"] else {
                continue
            }
            out[path] = slug
        }
        return out
    }

    /// `documents`: url (== `pages.path`) -> (key, framework). Only rows with a non-null `url` can
    /// ever correlate to a page (a null-url document has no corresponding `pages` row to resolve).
    private static func loadDocumentByUrl(_ db: Database) throws(DBError) -> [String: DocumentInfo] {
        let rows = try db.prepare("SELECT key, url, framework FROM documents WHERE url IS NOT NULL").all([:])
        var out: [String: DocumentInfo] = [:]
        out.reserveCapacity(rows.count)
        for row in rows {
            guard case .text(let key)? = row["key"], case .text(let url)? = row["url"] else { continue }
            var framework: String?
            if case .text(let value)? = row["framework"] { framework = value }
            out[url] = DocumentInfo(key: key, framework: framework)
        }
        return out
    }

    /// `pages`: (path, root_id) for every ACTIVE page — the repair's scope (matches
    /// `refreshRootPageCount`'s own `status = 'active'` filter, so the repaired `root_id`s and the
    /// recomputed `page_count`s that follow stay consistent with each other).
    private static func loadActivePages(_ db: Database) throws(DBError) -> [PageRow] {
        let rows = try db.prepare("SELECT path, root_id FROM pages WHERE status = 'active'").all([:])
        var out: [PageRow] = []
        out.reserveCapacity(rows.count)
        for row in rows {
            guard case .text(let path)? = row["path"], case .integer(let rootId)? = row["root_id"] else {
                continue
            }
            out.append(PageRow(path: path, rootId: rootId))
        }
        return out
    }

    // MARK: - resolve (pure, in-memory)

    /// One page's correct root id: `crawl_state.root_slug` (primary — set at BFS-seed time from the
    /// path string, immune to the bug) if a crawl_state row exists for this page's `documents.key`,
    /// else `documents.framework` (the only signal a flat source's pages have at all). `nil` when the
    /// page has no matching `documents` row, no resolvable slug, or the resolved slug matches no known
    /// root — the caller leaves such a page untouched rather than guessing.
    private static func resolveDesiredRootId(
        path: String, documentByUrl: [String: DocumentInfo], crawlStateSlugByKey: [String: String],
        rootIdBySlug: [String: Int64]
    ) -> Int64? {
        guard let info = documentByUrl[path] else { return nil }
        guard let desiredSlug = crawlStateSlugByKey[info.key] ?? info.framework else { return nil }
        return rootIdBySlug[desiredSlug]
    }

    // MARK: - write (batched; see the file header for why grouped by target root)

    /// Writes every `(path, rootId)` update, grouped by target root id and chunked to at most
    /// `batchSize` paths per statement — one `UPDATE pages SET root_id = $root_id WHERE path IN (…)`
    /// per chunk, each its own transaction.
    private static func applyRootIdUpdates(
        _ db: Database, updates: [(path: String, rootId: Int64)], batchSize: Int
    ) throws(DBError) {
        guard !updates.isEmpty else { return }
        var pathsByTargetRoot: [Int64: [String]] = [:]
        for update in updates { pathsByTargetRoot[update.rootId, default: []].append(update.path) }

        for (targetRootId, paths) in pathsByTargetRoot {
            var start = 0
            while start < paths.count {
                let end = Swift.min(start + batchSize, paths.count)
                let chunk = paths[start ..< end]
                var placeholders: [String] = []
                placeholders.reserveCapacity(chunk.count)
                var params: [String: Value] = ["root_id": .integer(targetRootId)]
                for (index, path) in chunk.enumerated() {
                    placeholders.append("$p\(index)")
                    params["p\(index)"] = .text(path)
                }
                let sql =
                    "UPDATE pages SET root_id = $root_id WHERE path IN ("
                    + placeholders.joined(separator: ", ") + ")"
                try db.transaction { (txn) throws(DBError) in _ = try txn.run(sql, params) }
                start = end
            }
        }
    }
}
