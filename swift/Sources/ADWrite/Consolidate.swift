// Consolidate — the failed-crawl doctor's SYNCHRONOUS half (ports of
// src/commands/consolidate.js steps 1-2 + src/commands/consolidate/storage-helpers.js
// + the retry-transient.js CLASSIFIER). Everything network-touching (the resolved-path
// re-fetch, the transient sweep) lives in `ADBuilderPipeline.ConsolidateDriver`, which
// drives these helpers over the same adapter/HTTP machinery the crawl uses.
//
// What lives here:
//   • `isInvalidFailedPath` — failed crawl_state rows that can never resolve to a
//     standalone page (fragments, dot-operators, JSON:API `-data.dictionary` artifacts,
//     paths the normalizer rewrites). storage-helpers.js, verbatim.
//   • `isCrossAdapterFalsePositive` — a failed catalog-crawl path whose root slug is
//     owned by a different (flat) adapter (roots.source_type outside {apple-docc, hig}):
//     the page IS in the corpus under that adapter's keys, so the apple-docc 404 is a
//     false positive to drop, not a missing page. consolidate.js + command-helpers.js.
//   • `analyze` — steps 1-2 of consolidate(): clean the never-resolvable rows, then
//     re-resolve the remainder against their parent page's raw-json `references`
//     (the JS readJSON(keyPath(dataDir,'raw-json',parent,'.json')) walk). A corpus the
//     native crawl built has no raw-json tree (the storage pivot keeps content in the
//     DB), so resolution is naturally a no-op there — exactly what the JS does when the
//     parent file is absent.
//   • `isTransientError` — the retry-transient.js TRANSIENT_RE, verbatim, PLUS the
//     native crawl's own error spellings (`String(describing:)` of AdapterError /
//     FetchError): `httpStatus(5xx|408|429, …)` and `transport(…connectionFailed/tls/
//     deadlineExceeded…)`. The JS regex is anchored on Bun fetch error strings; a
//     natively-crawled corpus stores the Swift forms, so both must classify.
//   • the `consolidate:retry-resolved` sync_checkpoint (resume), the singleton
//     activity-row bracket, and `minifyDir` (the `--minify` trailing pass).

import ADBase
import ADJSONCore
public import ADStorage
import Foundation

public enum Consolidate {
    /// `ROOT_CATALOG_SOURCE_TYPES` (command-helpers.js) — the source types whose roots
    /// the apple-docc catalog crawl legitimately owns; any other root's failed path is
    /// a cross-adapter false positive.
    public static let rootCatalogSourceTypes: Set<String> = ["apple-docc", "hig"]

    /// `CONSOLIDATE_RETRY_CHECKPOINT` (consolidate.js) — the sync_checkpoint key the
    /// resolved-path retry persists its resume state under.
    public static let retryCheckpointKey = "consolidate:retry-resolved"

    /// One failed crawl_state row (`SELECT path, root_slug, error … status='failed'`).
    public struct FailedRow: Sendable, Equatable {
        public let path: String
        public let rootSlug: String
        public let error: String?
        public init(path: String, rootSlug: String, error: String?) {
            self.path = path
            self.rootSlug = rootSlug
            self.error = error
        }
    }

    /// One re-resolved path (consolidate.js `resolvedPaths` entry): the failed path,
    /// the corrected URL path from the parent's references, the FAILED row's root slug,
    /// and the reference title (absent in JS when the reference carries none).
    public struct ResolvedPath: Sendable, Equatable {
        public let oldPath: String
        public let newPath: String
        public let root: String
        public let title: String?
        public init(oldPath: String, newPath: String, root: String, title: String?) {
            self.oldPath = oldPath
            self.newPath = newPath
            self.root = root
            self.title = title
        }
    }

    /// Steps 1-2's outcome: the counters + the resolution list steps 3+ consume.
    public struct Analysis: Sendable, Equatable {
        public var analyzed: Int
        public var cleaned: Int
        public var crossAdapter: Int
        public var resolved: Int
        public var resolvedPaths: [ResolvedPath]
    }

    /// The `consolidate:retry-resolved` checkpoint payload (JS field-for-field —
    /// `crossAdapter` is deliberately NOT stored, matching the JS object).
    public struct Checkpoint: Sendable, Equatable {
        public var analyzed: Int
        public var cleaned: Int
        public var resolved: Int
        public var retried: Int
        public var retriedOk: Int
        public var nextIndex: Int
        public var resolvedPaths: [ResolvedPath]
        public init(
            analyzed: Int, cleaned: Int, resolved: Int, retried: Int, retriedOk: Int,
            nextIndex: Int, resolvedPaths: [ResolvedPath]
        ) {
            self.analyzed = analyzed
            self.cleaned = cleaned
            self.resolved = resolved
            self.retried = retried
            self.retriedOk = retriedOk
            self.nextIndex = nextIndex
            self.resolvedPaths = resolvedPaths
        }
    }

    // MARK: - classification

    /// `isInvalidFailedPath` (storage-helpers.js): the normalizer rejects the path
    /// outright, it embeds a `#` fragment, it is a JSON:API `-data.dictionary`
    /// relationship/link artifact (a structural OpenAPI node, never a standalone page),
    /// or normalizing it produces something different.
    public static func isInvalidFailedPath(_ path: String) -> Bool {
        guard let renorm = Identifier.normalize(path) else { return true }
        if path.contains("#") { return true }
        if path.contains("-data.dictionary") { return true }
        return renorm != path
    }

    /// `isCrossAdapterFalsePositive` (consolidate.js): the path's root slug resolves to
    /// a registered root whose `source_type` is NOT a catalog type. (A NULL source_type
    /// also counts — the JS `!Set.has(null)`.)
    public static func isCrossAdapterFalsePositive(
        _ db: SQLiteWriteConnection, path: String
    ) throws(SQLiteWriteError) -> Bool {
        guard let root = try rootBySlug(db, extractRootSlug(path)) else { return false }
        return !rootCatalogSourceTypes.contains(root.sourceType ?? "")
    }

    /// `extractRootSlug` (apple/normalizer.js) — the leading path segment.
    static func extractRootSlug(_ path: String) -> String {
        String(path.prefix { $0 != "/" })
    }

    /// `TRANSIENT_RE` (retry-transient.js), verbatim — retry HTTP 5xx / 408 / 429 and
    /// transport-level failures; everything else (404/403/other 4xx) is permanent.
    /// Extended with the native crawl's error spellings (`String(describing:)` forms):
    /// `httpStatus(5xx|408|429, "…")` (AdapterError — e.g. the wwdc adapter's non-2xx
    /// throw) and `transport(…connectionFailed/tls/deadlineExceeded…)` (FetchError over
    /// HTTPClientError, retries exhausted). The JS regex alone would misclassify a
    /// natively-crawled corpus's transient rows as permanent.
    nonisolated(unsafe) private static let transientPattern =
        #/\bHTTP (5\d{2}|408|429)\b|timed? ?out|timeout|fetch failed|unable to connect|network|socket|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|httpStatus\((5\d{2}|408|429), |transport\(.*\.(connectionFailed\(|tls\(|deadlineExceeded)/#
        .ignoresCase()

    /// `isTransientError(error)` — string errors matching the transient pattern only
    /// (`null`/`undefined` → false, the JS `typeof error === 'string'` gate).
    public static func isTransientError(_ error: String?) -> Bool {
        guard let error else { return false }
        return error.contains(transientPattern)
    }

    // MARK: - steps 1-2 (clean + re-resolve)

    /// consolidate.js steps 1-2: analyze every failed row, DELETE the never-resolvable
    /// ones (invalid paths / cross-adapter false positives — kept under dry-run), then
    /// re-resolve the remainder via their parent page's raw-json `references`. The JS
    /// dry-run quirk is preserved: the resolution pass filters only the INVALID rows
    /// out, so cross-adapter rows still go through parent resolution when dry.
    public static func analyze(
        _ db: SQLiteWriteConnection, dataDir: String, dryRun: Bool, log: ((String) -> Void)? = nil
    ) throws -> Analysis {
        let all = try failedRows(db)
        var analysis = Analysis(
            analyzed: all.count, cleaned: 0, crossAdapter: 0, resolved: 0, resolvedPaths: [])
        log?("Analyzing \(all.count) failed entries...")

        for failed in all {
            let invalid = isInvalidFailedPath(failed.path)
            let crossDup = try !invalid && isCrossAdapterFalsePositive(db, path: failed.path)
            if !invalid && !crossDup { continue }
            if !dryRun { try deleteCrawlState(db, path: failed.path) }
            if crossDup { analysis.crossAdapter += 1 } else { analysis.cleaned += 1 }
        }
        log?("Cleaned \(analysis.cleaned) invalid + \(analysis.crossAdapter) cross-adapter false-positive entries")

        let remaining = dryRun ? all.filter { !isInvalidFailedPath($0.path) } : try failedRows(db)
        for failed in remaining {
            if let resolved = try resolveViaParent(dataDir: dataDir, failed: failed) {
                analysis.resolvedPaths.append(resolved)
                analysis.resolved += 1
            }
        }
        log?("Resolved \(analysis.resolved) paths to correct URLs")
        return analysis
    }

    /// Step 2's per-row body: read the parent page's raw-json payload and scan its
    /// `references` for an entry whose normalized id IS the failed path but whose `url`
    /// normalizes to a DIFFERENT path (the corrected URL — e.g. a `-6h3g5` suffixed
    /// disambiguation). First matching reference wins (the JS `break`); a matching id
    /// whose url is empty/same keeps scanning (the JS `continue`).
    static func resolveViaParent(dataDir: String, failed: FailedRow) throws -> ResolvedPath? {
        let segments = failed.path.split(separator: "/", omittingEmptySubsequences: false)
        guard segments.count >= 2 else { return nil }
        let parentPath = segments.dropLast().joined(separator: "/")
        // JS keyPath throws on an invalid storage key; crawl keys are normalizer-shaped
        // so it cannot fire in practice — a nil here is treated as file-absent instead.
        guard let rawPath = keyPath(dataDir: dataDir, subdir: "raw-json", key: parentPath, ext: ".json"),
            let data = FileManager.default.contents(atPath: rawPath)
        else { return nil }
        // A present-but-unparseable parent is fatal in the JS (`file.json()` rejects,
        // cli.js prints `Error: <message>`); surface the same refusal shape.
        guard let document = try? ADJSON.parse(Array(data), options: JSONParseOptions(maxDepth: 512))
        else {
            throw MaintenanceError("consolidate: unparseable parent JSON at \(rawPath)")
        }
        var resolvedPath: ResolvedPath?
        document.root["references"]
            .forEachMember { id, ref in
                guard resolvedPath == nil else { return }
                guard Identifier.normalize(id) == failed.path,
                    let url = ref["url"].string, !url.isEmpty
                else { return }
                guard let urlPath = Identifier.normalize(url), urlPath != failed.path else { return }
                resolvedPath = ResolvedPath(
                    oldPath: failed.path, newPath: urlPath, root: failed.rootSlug,
                    title: ref["title"].string)
            }
        return resolvedPath
    }
}

// The DB-side helpers the JS consolidate gets from DocsDatabase (failed-row queries,
// root/page probes, the activity bracket, the retry checkpoint) plus `minifyDir`.
// Split from the enum body to stay within the type-body-length gate.
extension Consolidate {
    /// The roots-row fields consolidate reads (JS `getRootBySlug`).
    public struct RootRow: Sendable, Equatable {
        public let id: Int64
        public let sourceType: String?
    }

    /// `SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'`.
    public static func failedRows(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> [FailedRow] {
        let rows = try db.all("SELECT path, root_slug, error FROM crawl_state WHERE status = 'failed'")
        return rows.compactMap { row in
            guard let path = row.text("path"), let slug = row.text("root_slug") else { return nil }
            return FailedRow(path: path, rootSlug: slug, error: row.text("error"))
        }
    }

    /// The failed rows whose stored error classifies as transient (retry-transient.js
    /// `transientFailures()` — the JS filters in JS, not SQL).
    public static func transientFailures(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> [FailedRow] {
        try failedRows(db).filter { isTransientError($0.error) }
    }

    /// `SELECT COUNT(*) … status = 'failed'` — the result's `genuine` count.
    public static func genuineFailedCount(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) -> Int {
        Int(try db.get("SELECT COUNT(*) AS c FROM crawl_state WHERE status = 'failed'")?.int("c") ?? 0)
    }

    /// JS `db.getRootBySlug(slug)` — nil when no such root.
    public static func rootBySlug(
        _ db: SQLiteWriteConnection, _ slug: String
    ) throws(SQLiteWriteError) -> RootRow? {
        guard
            let row = try db.get(
                "SELECT id, source_type FROM roots WHERE slug = $slug", ["slug": .text(slug)])
        else { return nil }
        return RootRow(id: row.int("id") ?? 0, sourceType: row.text("source_type"))
    }

    /// JS `db.getPage(path)` as an existence probe: the documents row by key first
    /// (the normalized model), falling back to the legacy pages row.
    public static func pageExists(_ db: SQLiteWriteConnection, _ path: String) throws(SQLiteWriteError) -> Bool {
        if try db.get("SELECT 1 FROM documents WHERE key = $key", ["key": .text(path)]) != nil {
            return true
        }
        return try db.get("SELECT 1 FROM pages WHERE path = $path", ["path": .text(path)]) != nil
    }

    /// `DELETE FROM crawl_state WHERE path = ?` (the cleaning + retry-success delete).
    public static func deleteCrawlState(_ db: SQLiteWriteConnection, path: String) throws(SQLiteWriteError) {
        try db.run("DELETE FROM crawl_state WHERE path = $path", ["path": .text(path)])
    }

    // MARK: - activity bracket (repos/operations.js setActivity/clearActivity)

    /// `db.setActivity('consolidate')` — the singleton activity row (id = 1), roots NULL.
    public static func setActivity(
        _ db: SQLiteWriteConnection, action: String, now: String, pid: Int64
    ) throws(SQLiteWriteError) {
        try db.run(
            "INSERT OR REPLACE INTO activity (id, action, started_at, pid, roots) "
                + "VALUES (1, $action, $started_at, $pid, NULL)",
            ["action": .text(action), "started_at": .text(now), "pid": .integer(pid)])
    }

    /// `db.clearActivity()`.
    public static func clearActivity(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run("DELETE FROM activity WHERE id = 1")
    }

    // MARK: - the retry checkpoint (repos/operations.js get/set/clearSyncCheckpoint)

    /// Read + parse the `consolidate:retry-resolved` checkpoint; nil when absent or
    /// unparseable (the JS getSyncCheckpoint try/catch → null). Missing fields default
    /// to 0/[] — the consolidate.js `?? 0` / `?? []` reads.
    public static func readCheckpoint(_ db: SQLiteWriteConnection) -> Checkpoint? {
        guard
            let value = try? db.get(
                "SELECT value FROM sync_checkpoint WHERE key = $key",
                ["key": .text(retryCheckpointKey)])?
                .text("value"),
            let object = try? JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any]
        else { return nil }
        let paths = (object["resolvedPaths"] as? [[String: Any]] ?? [])
            .compactMap { entry -> ResolvedPath? in
                guard let oldPath = entry["oldPath"] as? String, let newPath = entry["newPath"] as? String,
                    let root = entry["root"] as? String
                else { return nil }
                return ResolvedPath(oldPath: oldPath, newPath: newPath, root: root, title: entry["title"] as? String)
            }
        func intField(_ key: String) -> Int { (object[key] as? NSNumber)?.intValue ?? 0 }
        return Checkpoint(
            analyzed: intField("analyzed"), cleaned: intField("cleaned"), resolved: intField("resolved"),
            retried: intField("retried"), retriedOk: intField("retriedOk"),
            nextIndex: intField("nextIndex"), resolvedPaths: paths)
    }

    /// Persist the checkpoint — the value is `JSON.stringify`-identical to the JS
    /// object (insertion key order; a nil title omits the key, the JS `undefined`).
    public static func writeCheckpoint(
        _ db: SQLiteWriteConnection, _ checkpoint: Checkpoint, now: String
    ) throws(SQLiteWriteError) {
        var value = "{\"analyzed\":\(checkpoint.analyzed),\"cleaned\":\(checkpoint.cleaned)"
        value += ",\"resolved\":\(checkpoint.resolved),\"retried\":\(checkpoint.retried)"
        value += ",\"retriedOk\":\(checkpoint.retriedOk),\"nextIndex\":\(checkpoint.nextIndex)"
        value += ",\"resolvedPaths\":\(resolvedPathsJSON(checkpoint.resolvedPaths))}"
        try db.run(
            "INSERT OR REPLACE INTO sync_checkpoint (key, value, updated_at) VALUES ($key, $value, $now)",
            ["key": .text(retryCheckpointKey), "value": .text(value), "now": .text(now)])
    }

    /// `db.clearSyncCheckpoint(CONSOLIDATE_RETRY_CHECKPOINT)`.
    public static func clearCheckpoint(_ db: SQLiteWriteConnection) throws(SQLiteWriteError) {
        try db.run(
            "DELETE FROM sync_checkpoint WHERE key = $key", ["key": .text(retryCheckpointKey)])
    }

    /// The checkpoint's `resolvedPaths` array as compact JS-stringify JSON — built
    /// through ADJSON's `.javaScript` encoder so string escaping is byte-identical.
    private static func resolvedPathsJSON(_ paths: [ResolvedPath]) -> String {
        let entries = paths.map { entry -> String in
            var pairs = "{\"oldPath\":\(jsString(entry.oldPath)),\"newPath\":\(jsString(entry.newPath))"
            pairs += ",\"root\":\(jsString(entry.root))"
            if let title = entry.title { pairs += ",\"title\":\(jsString(title))" }
            return pairs + "}"
        }
        return "[" + entries.joined(separator: ",") + "]"
    }

    /// One JS-stringify string literal (ADJSON `.javaScript` — JSON.stringify escapes).
    private static func jsString(_ text: String) -> String {
        guard let bytes = try? JSONValue.string(text).encodedBytes(options: .javaScript) else {
            return "\"\""
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    // MARK: - minify (storage-helpers.js minifyDir)

    /// `stableStringify` (storage/files.js): compact, ECMA-262 numbers, non-finite →
    /// null, recursively sorted object keys — the raw-json writer's canonical form.
    static let stableStringifyOptions = JSONEncodingOptions(
        nonFinite: .null, numberFormat: .ecma262, keyOrder: .sorted)

    /// Walk `dirPath` minifying raw-JSON payloads in place — the trailing pass of
    /// `consolidate --minify`. Skips non-JSON payloads (first byte not `{`/`[` — flat
    /// sources' Markdown/HTML), files already minified (no newline in the first 200
    /// bytes), and rewrites only when strictly smaller. Returns (count, bytes saved).
    public static func minifyDir(_ dirPath: String, log: ((String) -> Void)? = nil) -> (count: Int, saved: Int) {
        var count = 0
        var saved = 0
        minifyWalk(dirPath, count: &count, saved: &saved, log: log)
        return (count, saved)
    }

    private static func minifyWalk(_ dir: String, count: inout Int, saved: inout Int, log: ((String) -> Void)?) {
        let fileManager = FileManager.default
        // JS readdirSync throw → return; the listing order is platform-defined there,
        // sorted here for determinism (count/saved are order-independent).
        guard let entries = try? fileManager.contentsOfDirectory(atPath: dir) else { return }
        for name in entries.sorted() {
            let full = dir + "/" + name
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: full, isDirectory: &isDirectory) else { continue }
            if isDirectory.boolValue {
                minifyWalk(full, count: &count, saved: &saved, log: log)
                continue
            }
            guard name.hasSuffix(".json") else { continue }
            minifyFile(full, count: &count, saved: &saved, log: log)
            if count > 0 && count % 5000 == 0 {
                log?("Minified \(count) files so far (\(megabytes(saved)) MB saved)...")
            }
        }
    }

    private static func minifyFile(_ path: String, count: inout Int, saved: inout Int, log: ((String) -> Void)?) {
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let head = data.prefix(200)
            // 123 = '{', 91 = '[' — skip files that aren't actually JSON.
            guard let firstByte = head.first, firstByte == 123 || firstByte == 91 else { return }
            // Already minified if no newline in the first 200 bytes.
            guard head.contains(10) else { return }
            let document = try ADJSON.parse(Array(data), options: JSONParseOptions(maxDepth: 512))
            let minified = try JSONValue(document.root).encodedBytes(options: stableStringifyOptions)
            if minified.count < data.count {
                try Data(minified).write(to: URL(fileURLWithPath: path))
                saved += data.count - minified.count
                count += 1
            }
        } catch {
            log?("Minify failed: \(path)")
        }
    }

    /// JS `(bytes / 1e6).toFixed(1)`.
    public static func megabytes(_ bytes: Int) -> String {
        String(format: "%.1f", Double(bytes) / 1e6)
    }
}
