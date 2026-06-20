// The `ad-cli status` verb — the sixth and final read verb of the P7 native CLI.
// Mirrors cli.js's `status` dispatch byte-for-byte: gathers the rich status
// envelope (corpus stats + activity + crawl progress + disk sizing + snapshot
// provenance + freshness + optional GitHub update check), then prints either the
// RAW envelope (`--advanced`) or the projected user shape (default), as the human
// `formatStatus` (Format.swift) or `JSON.stringify(result, null, 2)` (`--json`).
//
// Determinism: the GitHub update-check is skipped when APPLE_DOCS_SKIP_UPDATE_CHECK
// is set/non-empty (updateAvailable = null), exactly as cli.js passes
// `skipUpdateCheck: !!process.env.APPLE_DOCS_SKIP_UPDATE_CHECK`. The parity
// harness sets it on both sides; production leaves it unset and the check runs.
//
// Key order is pinned to the JS oracle: projectStatus's STATUS_KEEP_USER order
// for the default shape, status.js's return order for `--advanced`.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

struct StatusCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "status",
        abstract: "Corpus status, activity state, and crawl progress (mirrors cli.js status).")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .long, help: "Emit the full raw envelope (tier / capabilities / crawler internals).")
    var advanced = false

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            throw ExitCode(1)
        }

        let raw = gatherStatus(connection: connection, dbPath: corpus.db)

        if json {
            let value = advanced ? statusAdvancedJSON(raw) : statusDefaultJSON(raw)
            print(stringifyPretty(value))
        } else {
            print(formatStatus(raw, advanced: advanced))
        }
    }
}

// MARK: - the rich status envelope (status.js `status(...)` return shape)

/// `{ size, files }` for a content directory (raw-json / markdown). A missing dir
/// → `{ size: 0, files: 0 }` (matches JS `dirSize` / `fileCount`).
struct DirStats {
    let size: Int64
    let files: Int64
}

/// Snapshot provenance — `{ tag, buildMacos }`, or nil when neither is present.
struct SnapshotInfo {
    let tag: String?
    let buildMacos: String?
}

/// The capabilities block (advanced only): all booleans.
struct Capabilities {
    let search: Bool
    let searchTrigram: Bool
    let searchBody: Bool
    let readContent: Bool
}

/// status.js's `activity` shape: action / startedAt / pid / alive / roots /
/// status ('running' | 'interrupted'). Built from the ADStorage row.
struct StatusActivity {
    let action: String?
    let startedAt: String?
    let pid: Int64?
    let alive: Bool
    /// The parsed roots array (string elements), or nil. Used by both the human
    /// formatter (`a.roots ? roots.join(', ')`) and the advanced JSON shape.
    let roots: [String]?
    /// 'running' when alive, else 'interrupted'.
    let status: String
}

/// freshnessCheck result: lastSyncAt / daysSinceSync / isStale / staleRoots.
struct Freshness {
    let lastSyncAt: String?
    let daysSinceSync: Int64?
    let isStale: Bool
    let staleRoots: [StaleRoot]
}

/// One stale root `{ slug, daysSince }` (advanced only; projectStatus drops it).
struct StaleRoot {
    let slug: String
    let daysSince: Int64
}

/// checkForUpdate result: `{ current, latest, available }`, or nil.
struct UpdateAvailable {
    let current: String
    let latest: String
    let available: Bool
}

/// Overall crawl progress `{ total, processed, pending, failed }`.
struct CrawlProgress {
    let total: Int64
    let processed: Int64
    let pending: Int64
    let failed: Int64
}

/// Per-root crawl progress as status.js shapes it (root / processed / pending /
/// failed / total / percent).
struct CrawlByRootEntry {
    let root: String?
    let processed: Int64
    let pending: Int64
    let failed: Int64
    let total: Int64
    let percent: Int64
}

/// The full status envelope, in field-source order. `statusDefaultJSON` /
/// `statusAdvancedJSON` / `formatStatus` derive their output from this.
struct StatusEnvelope {
    let dataDir: String
    let tier: String?
    let snapshot: SnapshotInfo?
    let capabilities: Capabilities
    let databaseSize: Int64
    let rawJson: DirStats
    let markdown: DirStats
    let rootsTotal: Int64
    let rootsByKind: [(String, Int64)]
    let pagesActive: Int64
    let pagesDeleted: Int64
    let activity: StatusActivity?
    let crawlProgress: CrawlProgress
    let crawlByRoot: [CrawlByRootEntry]
    let lastSync: String?
    let lastAction: String?
    let updateAvailable: UpdateAvailable?
    let freshness: Freshness
}

// MARK: - gather (status.js `status(opts, ctx)`)

/// Builds the rich envelope. Mirrors status.js: dataDir = the directory holding
/// the db (cli.js's `--home`); databaseSize / rawJson / markdown via Foundation
/// FileManager; corpus stats from ADStorage; freshness from the update_log; the
/// update check honouring APPLE_DOCS_SKIP_UPDATE_CHECK.
func gatherStatus(connection: StorageConnection, dbPath: String) -> StatusEnvelope {
    // cli.js `dataDir` = `--home` = the directory containing apple-docs.db. The
    // native verb takes `--db <dataDir>/apple-docs.db`, so dataDir is its parent.
    let dataDir = (dbPath as NSString).deletingLastPathComponent
    let stats = connection.corpusStats()

    // status.js sizes `join(dataDir, 'apple-docs.db')` (derived from dataDir, not
    // the raw --db arg). They coincide here (basename is apple-docs.db), but the
    // reconstruction is the faithful port.
    let dbSize = fileSize(joinPath(dataDir, "apple-docs.db"))
    let rawJson = dirStats(joinPath(dataDir, "raw-json"))
    let markdown = dirStats(joinPath(dataDir, "markdown"))

    // Activity: running vs interrupted (alive flag from the DB-side kill probe).
    let activity: StatusActivity? = stats.activity.map { row in
        StatusActivity(
            action: row.action, startedAt: row.startedAt, pid: row.pid, alive: row.alive,
            roots: parseRootsArray(row.rootsJSON), status: row.alive ? "running" : "interrupted")
    }

    let crawlProgress = CrawlProgress(
        total: stats.crawlProgress.total, processed: stats.crawlProgress.processed,
        pending: stats.crawlProgress.pending, failed: stats.crawlProgress.failed)

    let crawlByRoot = stats.crawlByRoot.map { row -> CrawlByRootEntry in
        let total = row.processed + row.pending + row.failed
        // `Math.round((processed / total) * 100)` — 0 when total == 0.
        let percent = total > 0 ? jsRound(Double(row.processed) / Double(total) * 100) : 0
        return CrawlByRootEntry(
            root: row.rootSlug, processed: row.processed, pending: row.pending, failed: row.failed,
            total: total, percent: percent)
    }

    // Update check: null when skipped (env) or when there's no snapshot tag /
    // any failure; else the GitHub `releases/latest` comparison.
    let skipUpdateCheck = !(ProcessInfo.processInfo.environment["APPLE_DOCS_SKIP_UPDATE_CHECK"] ?? "").isEmpty
    let updateAvailable = skipUpdateCheck ? nil : checkForUpdate(connection)

    // Snapshot provenance (tag prefers snapshot_tag, else snapshot_version).
    let snapshotTag = connection.getSnapshotMeta("snapshot_tag") ?? connection.getSnapshotMeta("snapshot_version")
    let snapshotBuildMacos = connection.getSnapshotMeta("build_macos")
    let snapshot: SnapshotInfo? =
        (snapshotTag != nil || snapshotBuildMacos != nil)
        ? SnapshotInfo(tag: snapshotTag, buildMacos: snapshotBuildMacos) : nil

    let tier = connection.snapshotTier()
    let capabilities = Capabilities(
        search: true, searchTrigram: connection.hasTable("documents_trigram"),
        searchBody: connection.hasBodyIndex(), readContent: connection.hasTable("document_sections"))

    let byKind = stats.rootsByKind.map { (jsKey($0.kind), $0.count) }

    return StatusEnvelope(
        dataDir: dataDir, tier: tier, snapshot: snapshot, capabilities: capabilities,
        databaseSize: dbSize, rawJson: rawJson, markdown: markdown, rootsTotal: stats.totalRoots,
        rootsByKind: byKind, pagesActive: stats.totalPages, pagesDeleted: stats.totalDeleted,
        activity: activity, crawlProgress: crawlProgress, crawlByRoot: crawlByRoot,
        lastSync: stats.lastLog?.timestamp, lastAction: stats.lastLog?.action,
        updateAvailable: updateAvailable, freshness: freshnessCheck(connection))
}

/// freshnessCheck(db): the last global sync time + per-root staleness. A null
/// last timestamp ⇒ `{ lastSyncAt: null, daysSinceSync: null, isStale: true,
/// staleRoots: [] }`. Otherwise daysSinceSync = floor((now - lastSyncAt)/86400000)
/// and isStale = daysSinceSync > 14. Uses the CURRENT time (Date()), like the JS
/// `Date.now()`; the harness runs both sides within the same second.
func freshnessCheck(_ connection: StorageConnection) -> Freshness {
    let last = connection.lastUpdateLog()
    guard let lastSyncAt = last?.timestamp else {
        return Freshness(lastSyncAt: nil, daysSinceSync: nil, isStale: true, staleRoots: [])
    }
    let nowMs = Date().timeIntervalSince1970 * 1000
    let days = daysSince(lastSyncAt, nowMs: nowMs)
    let staleRoots = connection.staleRootEntries(nowMs: nowMs)
    return Freshness(lastSyncAt: lastSyncAt, daysSinceSync: days, isStale: (days ?? 0) > 14, staleRoots: staleRoots)
}

/// `Math.floor((now - Date.parse(iso)) / 86400000)`. Date.parse on a malformed
/// string yields NaN ⇒ the JS arithmetic is NaN ⇒ Math.floor(NaN) = NaN, which
/// `JSON.stringify` emits as null. We return nil for an unparseable timestamp to
/// match that (real update_log timestamps are ISO-8601, always parseable).
private func daysSince(_ iso: String, nowMs: Double) -> Int64? {
    guard let parsed = parseISODate(iso) else { return nil }
    let diff = (nowMs - parsed) / 86_400_000
    return Int64(diff.rounded(.down))
}

// MARK: - update check (status.js `checkForUpdate`)

/// checkForUpdate(db): null when there's no `snapshot_tag`; else GET the GitHub
/// `releases/latest` (User-Agent / Accept / optional Bearer, 5 s timeout) and
/// compare `tag_name` to the current tag. Any non-200 / network / parse failure
/// → null (the JS try/catch). Synchronous (the verb is non-async); a semaphore
/// bridges URLSession's async completion.
func checkForUpdate(_ connection: StorageConnection) -> UpdateAvailable? {
    guard let currentTag = connection.getSnapshotMeta("snapshot_tag") else { return nil }

    guard let url = URL(string: "https://api.github.com/repos/g-cqd/apple-docs/releases/latest") else {
        return nil
    }
    var request = URLRequest(url: url)
    request.setValue("apple-docs/2.0", forHTTPHeaderField: "User-Agent")
    request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
    let env = ProcessInfo.processInfo.environment
    if let token = env["GITHUB_TOKEN"] ?? env["GH_TOKEN"], !token.isEmpty {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    request.timeoutInterval = 5

    let semaphore = DispatchSemaphore(value: 0)
    var responseData: Data?
    var statusCode = 0
    let task = URLSession.shared.dataTask(with: request) { data, response, _ in
        if let http = response as? HTTPURLResponse { statusCode = http.statusCode }
        responseData = data
        semaphore.signal()
    }
    task.resume()
    // Wait a touch past the request timeout so a hung connection can't block the
    // verb forever; a timeout leaves responseData nil ⇒ null (the JS catch path).
    if semaphore.wait(timeout: .now() + 6) == .timedOut {
        task.cancel()
        return nil
    }

    guard statusCode == 200, let data = responseData,
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let latestTag = object["tag_name"] as? String
    else { return nil }

    return UpdateAvailable(current: currentTag, latest: latestTag, available: latestTag != currentTag)
}

// MARK: - default (projected) JSON — projectStatus + STATUS_KEEP_USER key order

/// projectStatus(raw): the trimmed user shape. Key order = STATUS_KEEP_USER
/// (dataDir, databaseSize, snapshot, rawJson, markdown, lastSync, lastAction —
/// each emitted only if present, `pick` keeping defined-but-null), then `pages`,
/// `roots`, then (only if present) `activity`, `updateAvailable` (only when
/// `available`), `freshness` (only when `lastSyncAt`).
func statusDefaultJSON(_ raw: StatusEnvelope) -> JSONValue {
    var pairs: [(String, JSONValue)] = []

    // STATUS_KEEP_USER pick (in order). `dataDir` / `databaseSize` always set;
    // `snapshot` only when non-nil; `rawJson` / `markdown` always set; `lastSync`
    // / `lastAction` are defined (possibly null) on the raw envelope ⇒ kept.
    pairs.append(("dataDir", .string(raw.dataDir)))
    pairs.append(("databaseSize", .int(raw.databaseSize)))
    if let snapshot = raw.snapshot { pairs.append(("snapshot", snapshotJSON(snapshot))) }
    pairs.append(("rawJson", dirStatsJSON(raw.rawJson)))
    pairs.append(("markdown", dirStatsJSON(raw.markdown)))
    pairs.append(("lastSync", optString(raw.lastSync)))
    pairs.append(("lastAction", optString(raw.lastAction)))

    pairs.append(("pages", .obj([("active", .int(raw.pagesActive)), ("deleted", .int(raw.pagesDeleted))])))
    pairs.append(("roots", .obj([("total", .int(raw.rootsTotal)), ("byKind", byKindJSON(raw.rootsByKind))])))

    if let activity = raw.activity {
        pairs.append(
            (
                "activity",
                .obj([
                    ("action", optString(activity.action)), ("status", .string(activity.status)),
                    ("startedAt", optString(activity.startedAt))
                ])))
    }
    if let update = raw.updateAvailable, update.available {
        pairs.append(
            ("updateAvailable", .obj([("current", .string(update.current)), ("latest", .string(update.latest))])))
    }
    if let lastSyncAt = raw.freshness.lastSyncAt {
        pairs.append(
            (
                "freshness",
                .obj([
                    ("lastSyncAt", .string(lastSyncAt)), ("daysSinceSync", optInt(raw.freshness.daysSinceSync)),
                    ("isStale", .bool(raw.freshness.isStale))
                ])))
    }
    return .obj(pairs)
}

// MARK: - advanced (raw) JSON — status.js return order

/// The raw envelope as `--advanced` emits it, keys in status.js's RETURN order:
/// dataDir, tier, snapshot, capabilities, databaseSize, rawJson, markdown, roots,
/// pages, activity, crawlProgress, crawlByRoot, lastSync, lastAction,
/// updateAvailable, freshness. nil scalars / objects serialize as JSON `null`.
func statusAdvancedJSON(_ raw: StatusEnvelope) -> JSONValue {
    .obj([
        ("dataDir", .string(raw.dataDir)),
        ("tier", optString(raw.tier)),
        ("snapshot", raw.snapshot.map(snapshotJSON) ?? .null),
        ("capabilities", capabilitiesJSON(raw.capabilities)),
        ("databaseSize", .int(raw.databaseSize)),
        ("rawJson", dirStatsJSON(raw.rawJson)),
        ("markdown", dirStatsJSON(raw.markdown)),
        ("roots", .obj([("total", .int(raw.rootsTotal)), ("byKind", byKindJSON(raw.rootsByKind))])),
        ("pages", .obj([("active", .int(raw.pagesActive)), ("deleted", .int(raw.pagesDeleted))])),
        ("activity", raw.activity.map(activityJSON) ?? .null),
        ("crawlProgress", crawlProgressJSON(raw.crawlProgress)),
        ("crawlByRoot", .array(raw.crawlByRoot.map(crawlByRootJSON))),
        ("lastSync", optString(raw.lastSync)),
        ("lastAction", optString(raw.lastAction)),
        ("updateAvailable", raw.updateAvailable.map(updateJSON) ?? .null),
        ("freshness", freshnessJSON(raw.freshness))
    ])
}

// MARK: - JSON fragment builders (pinned key order each)

private func snapshotJSON(_ s: SnapshotInfo) -> JSONValue {
    .obj([("tag", optString(s.tag)), ("buildMacos", optString(s.buildMacos))])
}

private func dirStatsJSON(_ d: DirStats) -> JSONValue {
    .obj([("size", .int(d.size)), ("files", .int(d.files))])
}

private func capabilitiesJSON(_ c: Capabilities) -> JSONValue {
    .obj([
        ("search", .bool(c.search)), ("searchTrigram", .bool(c.searchTrigram)),
        ("searchBody", .bool(c.searchBody)), ("readContent", .bool(c.readContent))
    ])
}

/// `Object.fromEntries(rootsByKind.map(...))` — insertion-ordered object keyed by
/// kind. A NULL kind column coalesces to "null" (jsKey, set at gather time).
private func byKindJSON(_ entries: [(String, Int64)]) -> JSONValue {
    .obj(entries.map { ($0.0, .int($0.1)) })
}

private func activityJSON(_ a: StatusActivity) -> JSONValue {
    // status.js order: action, startedAt, pid, alive, roots, status.
    .obj([
        ("action", optString(a.action)),
        ("startedAt", optString(a.startedAt)),
        ("pid", optInt(a.pid)),
        ("alive", .bool(a.alive)),
        ("roots", a.roots.map { .array($0.map(JSONValue.string)) } ?? .null),
        ("status", .string(a.status))
    ])
}

private func crawlProgressJSON(_ c: CrawlProgress) -> JSONValue {
    .obj([
        ("total", .int(c.total)), ("processed", .int(c.processed)),
        ("pending", .int(c.pending)), ("failed", .int(c.failed))
    ])
}

private func crawlByRootJSON(_ r: CrawlByRootEntry) -> JSONValue {
    .obj([
        ("root", optString(r.root)), ("processed", .int(r.processed)), ("pending", .int(r.pending)),
        ("failed", .int(r.failed)), ("total", .int(r.total)), ("percent", .int(r.percent))
    ])
}

private func updateJSON(_ u: UpdateAvailable) -> JSONValue {
    .obj([("current", .string(u.current)), ("latest", .string(u.latest)), ("available", .bool(u.available))])
}

private func freshnessJSON(_ f: Freshness) -> JSONValue {
    .obj([
        ("lastSyncAt", optString(f.lastSyncAt)),
        ("daysSinceSync", optInt(f.daysSinceSync)),
        ("isStale", .bool(f.isStale)),
        ("staleRoots", .array(f.staleRoots.map { .obj([("slug", .string($0.slug)), ("daysSince", .int($0.daysSince))]) }))
    ])
}

private func optString(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
private func optInt(_ value: Int64?) -> JSONValue { value.map(JSONValue.int) ?? .null }

// MARK: - human formatter (src/cli/formatters/status.js `formatStatus`)

/// Port of `formatStatus`. The `advanced` flag selects which fields the JS
/// formatter would see: the projected (default) object has no `tier`,
/// `capabilities`, `crawlProgress`, and (on this corpus) no `freshness`; the raw
/// (advanced) object carries all of them. Drives the same line-building logic off
/// the single envelope, gating those blocks on `advanced` to match the two inputs.
func formatStatus(_ raw: StatusEnvelope, advanced: Bool) -> String {
    let kindStr = raw.rootsByKind.map { "\($0.1) \($0.0)" }.joined(separator: ", ")

    // `tier` only appears in the advanced envelope.
    let tierLabel = (advanced && raw.tier != nil) ? " [\(raw.tier!) tier]" : ""

    let snapshotLine: String? = raw.snapshot.map { s in
        let macos = s.buildMacos.map { " (built on macOS \($0))" } ?? ""
        return "\(s.tag ?? "unknown tag")\(macos)"
    }

    var lines: [String] = [
        bold("Apple Documentation Corpus\(tierLabel)"),
        "  Data directory:  \(raw.dataDir)"
    ]
    if let snapshotLine { lines.append("  Snapshot:        \(snapshotLine)") }
    lines.append("  Database:        \(formatBytes(raw.databaseSize))")
    lines.append("  Raw JSON:        \(formatBytes(raw.rawJson.size)) (\(raw.rawJson.files) files)")
    lines.append("  Markdown:        \(formatBytes(raw.markdown.size)) (\(raw.markdown.files) files)")
    lines.append("  Roots:           \(raw.rootsTotal) (\(kindStr.isEmpty ? "none" : kindStr))")
    lines.append("  Pages:           \(raw.pagesActive) active, \(raw.pagesDeleted) deleted")
    lines.append("  Last sync:       \(raw.lastSync ?? "never")")
    lines.append("  Last action:     \(raw.lastAction ?? "none")")

    // capabilities — advanced only.
    if advanced {
        let c = raw.capabilities
        let caps = [
            "search: yes",
            "fuzzy: \(c.searchTrigram ? "yes" : "no")",
            "body: \(c.searchBody ? "yes" : "no")",
            "read: \(c.readContent ? "yes" : "metadata only")"
        ]
        lines.append("  Capabilities:    \(caps.joined(separator: ", "))")
    }

    // Activity (present in both shapes when non-nil; projectStatus keeps it).
    if let a = raw.activity {
        lines.append("")
        let rootsStr = a.roots.map { " (\($0.joined(separator: ", ")))" } ?? ""
        let pidStr = a.pid.map { " [pid \($0)]" } ?? ""
        if a.status == "running" {
            lines.append(bold("  Active:  \(a.action ?? "null")\(rootsStr) running since \(a.startedAt ?? "null")\(pidStr)"))
        } else {
            lines.append(bold("  Stopped: \(a.action ?? "null")\(rootsStr) was interrupted (started \(a.startedAt ?? "null"))"))
            lines.append("           Run \"apple-docs sync\" again to resume")
        }
    }

    // Crawl progress — advanced only (projectStatus drops crawlProgress), and
    // only when total > 0.
    if advanced && raw.crawlProgress.total > 0 {
        appendCrawlProgress(&lines, raw)
    }

    // updateAvailable — only when available (true in both shapes when present).
    if let update = raw.updateAvailable, update.available {
        lines.append("")
        lines.append(bold("  Update available: \(update.latest)"))
        lines.append("  Current:  \(update.current)")
        lines.append("  Run: apple-docs setup --force")
    }

    // freshness — `if (result.freshness)`. In ADVANCED the freshness object is
    // always carried (truthy) ⇒ the block always prints; on a no-sync corpus
    // `lastSyncAt` is null ⇒ "No sync history". In DEFAULT, projectStatus keeps
    // freshness ONLY when `lastSyncAt` is present, so the block prints only then —
    // and the projected freshness has dropped `staleRoots`, so that line never
    // shows in default. `formatStatusFreshness` applies both rules.
    appendFreshness(&lines, raw.freshness, advanced: advanced)

    return lines.joined(separator: "\n")
}

/// The advanced crawl-progress block (overall bar + per-root breakdown). Only
/// reached when `crawlProgress.total > 0`; empty on a snapshot corpus.
private func appendCrawlProgress(_ lines: inout [String], _ raw: StatusEnvelope) {
    let cp = raw.crawlProgress
    lines.append("")
    lines.append(bold("  Crawl Progress"))
    lines.append(
        "  Overall: \(cp.processed) processed, \(cp.pending) pending, \(cp.failed) failed / \(cp.total) total")
    lines.append("           \(progressBar(cp.processed, cp.total))")

    let active = raw.crawlByRoot.filter { $0.pending > 0 || $0.failed > 0 }
    let done = raw.crawlByRoot.filter { $0.pending == 0 && $0.failed == 0 }

    if !active.isEmpty {
        lines.append("")
        lines.append("  \(bold("In progress / incomplete:"))")
        for r in active {
            let failed = r.failed > 0 ? dim(" (\(r.failed) failed)") : ""
            lines.append("    \(r.root ?? "null"): \(r.processed)/\(r.total) \(progressBar(r.processed, r.total))\(failed)")
        }
    }

    if !done.isEmpty && done.count <= 10 {
        lines.append("")
        let list = done.map { "\($0.root ?? "null") (\($0.total))" }.joined(separator: ", ")
        lines.append("  \(bold("Complete:")) \(list)")
    } else if done.count > 10 {
        lines.append("")
        lines.append("  \(bold("Complete:")) \(done.count) roots")
    }
}

/// The `if (result.freshness)` block. In ADVANCED the freshness object is always
/// present (truthy) so the block prints; DEFAULT prints it only when the projected
/// shape kept freshness, i.e. `lastSyncAt` is present. `staleRoots` is shown only
/// in advanced (projectStatus drops it from the default shape).
private func appendFreshness(_ lines: inout [String], _ f: Freshness, advanced: Bool) {
    // Does the formatter's `result.freshness` exist for this shape?
    let freshnessPresent = advanced || f.lastSyncAt != nil
    guard freshnessPresent else { return }
    lines.append("")
    if let _ = f.lastSyncAt {
        let staleLabel = f.isStale ? " (STALE)" : ""
        lines.append("  Last sync:       \(f.daysSinceSync.map(String.init) ?? "null") days ago\(staleLabel)")
        if advanced && !f.staleRoots.isEmpty {
            let list = f.staleRoots.map { "\($0.slug) (\($0.daysSince)d)" }.joined(separator: ", ")
            lines.append("  Stale roots:     \(list)")
        }
    } else {
        lines.append("  Freshness:       No sync history")
    }
}

/// Port of `formatStatus`'s `bar(processed, total)`: `''` for total == 0; else a
/// 20-cell `[==== ] NN%` bar. filled = round((pct/100) * 20).
private func progressBar(_ processed: Int64, _ total: Int64) -> String {
    if total == 0 { return "" }
    let pct = jsRound(Double(processed) / Double(total) * 100)
    let width = 20
    let filled = Int(jsRound(Double(pct) / 100 * Double(width)))
    let clampedFilled = max(0, min(width, filled))
    return "[\(String(repeating: "=", count: clampedFilled))\(String(repeating: " ", count: width - clampedFilled))] \(pct)%"
}

// MARK: - helpers

/// `Math.round` — ties round toward +∞ (NOT away from zero): round(2.5) = 3,
/// round(-2.5) = -2. Implemented as floor(x + 0.5).
func jsRound(_ value: Double) -> Int64 {
    Int64((value + 0.5).rounded(.down))
}

/// `JSON.parse(rootsJSON)` for the activity roots column → `[String]`, or nil
/// (NULL / non-array / non-string-element / parse error), matching the JS truthy
/// use of the parsed value. Parses through ADJSON's `JSONValue` and accepts only
/// an array of strings (any other shape ⇒ nil).
func parseRootsArray(_ json: String?) -> [String]? {
    guard let json, !json.isEmpty, case let .array(items)? = parseJSONValue(json) else { return nil }
    var out: [String] = []
    out.reserveCapacity(items.count)
    for item in items {
        guard case let .string(string) = item else { return nil }
        out.append(string)
    }
    return out
}

/// A root `kind` column for the `byKind` object key. JS builds the key from
/// `r.kind` directly (`[r.kind, r.count]`); a NULL kind becomes the object key
/// `"null"` under `Object.fromEntries` (String(null)). Matches that coercion.
private func jsKey(_ kind: String?) -> String { kind ?? "null" }

/// Byte size of a file, or 0 when absent/unreadable (matches `existsSync ?
/// statSync(p).size : 0`).
private func fileSize(_ path: String) -> Int64 {
    guard let attributes = try? FileManager.default.attributesOfItem(atPath: path),
        let size = attributes[.size] as? NSNumber
    else { return 0 }
    return size.int64Value
}

/// `{ size, files }` of a directory: recursive byte sum + file count. A missing
/// directory → `{ 0, 0 }` (matches `dirSize` / `fileCount`, which return 0 for a
/// non-existent path). Counts regular files only (directories are descended, not
/// counted), mirroring `entry.isDirectory() ? walk : count++`.
private func dirStats(_ path: String) -> DirStats {
    let fileManager = FileManager.default
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
        return DirStats(size: 0, files: 0)
    }
    guard let enumerator = fileManager.enumerator(atPath: path) else { return DirStats(size: 0, files: 0) }

    var totalSize: Int64 = 0
    var fileCount: Int64 = 0
    for case let relative as String in enumerator {
        let full = joinPath(path, relative)
        var entryIsDir: ObjCBool = false
        guard fileManager.fileExists(atPath: full, isDirectory: &entryIsDir) else { continue }
        if entryIsDir.boolValue { continue }  // descended by the enumerator; not counted
        fileCount += 1
        if let attributes = try? fileManager.attributesOfItem(atPath: full),
            let size = attributes[.size] as? NSNumber
        {
            totalSize += size.int64Value
        }
    }
    return DirStats(size: totalSize, files: fileCount)
}

/// `path.join(a, b)` for the data-dir subpaths. Uses NSString to match the host
/// path semantics (single separator, no trailing slash issues).
private func joinPath(_ base: String, _ component: String) -> String {
    (base as NSString).appendingPathComponent(component)
}

/// `Date.parse(iso)` → epoch milliseconds, or nil for an unparseable string.
/// update_log timestamps are `new Date().toISOString()` (ISO-8601 UTC with
/// milliseconds, e.g. `2026-06-14T00:00:00.000Z`); ISO8601DateFormatter with
/// fractional seconds parses that. A plain (no-fraction) ISO string is retried.
private func parseISODate(_ iso: String) -> Double? {
    let withFraction = ISO8601DateFormatter()
    withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = withFraction.date(from: iso) { return date.timeIntervalSince1970 * 1000 }
    let plain = ISO8601DateFormatter()
    plain.formatOptions = [.withInternetDateTime]
    if let date = plain.date(from: iso) { return date.timeIntervalSince1970 * 1000 }
    return nil
}

extension StorageConnection {
    /// Per-root staleness for freshnessCheck's `staleRoots` (advanced only):
    /// `SELECT root_slug, MAX(timestamp) FROM update_log WHERE root_slug IS NOT
    /// NULL GROUP BY root_slug`, keeping rows whose daysSince > 14. Empty on this
    /// corpus (no update_log rows). Lives here (not ADStorage) because the
    /// daysSince math needs Foundation date parsing + the current time.
    fileprivate func staleRootEntries(nowMs: Double) -> [StaleRoot] {
        var out: [StaleRoot] = []
        for row in staleRootRows() {
            guard let parsed = parseISODate(row.lastUpdate) else { continue }
            let days = Int64(((nowMs - parsed) / 86_400_000).rounded(.down))
            if days > 14 { out.append(StaleRoot(slug: row.slug, daysSince: days)) }
        }
        return out
    }
}
