// `ad-cli storage …` — the read-only F1 storage verbs mirroring cli.js
// `storage stats` / `storage check-orphans` (src/cli/maintenance.js
// dispatchStorage → src/commands/storage.js). The write subcommands (gc,
// compact, materialize, profile) stay on the Bun path for now — the flip's
// VERB_SPECS only delegates what ad-cli faithfully honours.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// `ad-cli storage …` — the storage maintenance verb group.
struct StorageCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "storage", abstract: "Corpus storage maintenance (stats, orphan checks, profile).",
        subcommands: [StorageStatsCommand.self, StorageCheckOrphansCommand.self, StorageProfileCommand.self])
}

/// `ad-cli storage stats --db <PATH> [--json]` — the storage breakdown:
/// db(+wal) size, the four content dirs, per-table row counts, and the total.
struct StorageStatsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "stats", abstract: "Storage breakdown: sizes, file counts, row counts.")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            Foundation.exit(1)
        }
        let stats = gatherStorageStats(connection: connection, dbArgument: corpus.db)
        print(json ? stringifyPretty(storageStatsJSON(stats)) : formatStorageStats(stats))
    }
}

/// `ad-cli storage check-orphans --db <PATH> [--json]` — the read-only orphan /
/// FK-violation report (PRAGMA foreign_key_check + two semantic-orphan counts).
struct StorageCheckOrphansCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "check-orphans", abstract: "Report FK violations and semantic orphans (read-only).")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .long, help: "Emit JSON instead of the one-line summary.")
    var json = false

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            Foundation.exit(1)
        }
        let value = checkOrphansJSON(connection)
        // Human = `summary('orphans')`: the label + COMPACT JSON.stringify.
        print(json ? stringifyPretty(value) : "orphans: \(stringifyCompact(value))")
    }
}

// MARK: - storage stats assembly (storageStats in storage.js)

/// The gathered breakdown, field-for-field with the JS result object.
struct StorageStatsEnvelope {
    let dbPath: String
    let dbSize: Int64
    let rawJson: DirStats
    let markdown: DirStats
    let html: DirStats
    let resources: DirStats
    let tables: StorageTableCounts
    var total: Int64 { dbSize + rawJson.size + markdown.size + html.size + resources.size }
}

/// Mirrors storageStats: dataDir is the --db parent (cli.js's `--home`); the
/// db size re-derives `join(dataDir, 'apple-docs.db')` and adds the WAL only
/// when the db file itself stats (the JS try block aborts to 0 on the first
/// statSync throw, so a WAL next to a missing db is NOT counted).
func gatherStorageStats(connection: StorageConnection, dbArgument: String) -> StorageStatsEnvelope {
    let dataDir = (dbArgument as NSString).deletingLastPathComponent
    let dbPath = joinPath(dataDir, "apple-docs.db")
    var dbSize: Int64 = 0
    if FileManager.default.fileExists(atPath: dbPath) {
        dbSize = fileSize(dbPath)
        let walPath = "\(dbPath)-wal"
        if FileManager.default.fileExists(atPath: walPath) { dbSize += fileSize(walPath) }
    }
    return StorageStatsEnvelope(
        dbPath: dbPath, dbSize: dbSize,
        rawJson: dirStats(joinPath(dataDir, "raw-json")),
        markdown: dirStats(joinPath(dataDir, "markdown")),
        html: dirStats(joinPath(dataDir, "html")),
        resources: dirStats(joinPath(dataDir, "resources")),
        tables: connection.storageTableCounts())
}

/// The JS result object, key order pinned: database{size,path}, rawJson,
/// markdown, html, resources (each {size,files}), tables (five counts in
/// insertion order), total.
func storageStatsJSON(_ stats: StorageStatsEnvelope) -> JSONValue {
    .obj([
        ("database", .obj([("size", .int(stats.dbSize)), ("path", .string(stats.dbPath))])),
        ("rawJson", dirStatsJSON(stats.rawJson)),
        ("markdown", dirStatsJSON(stats.markdown)),
        ("html", dirStatsJSON(stats.html)),
        ("resources", dirStatsJSON(stats.resources)),
        ("tables", tableCountsJSON(stats.tables)),
        ("total", .int(stats.total))
    ])
}

/// The `tables` block in the JS insertion order.
private func tableCountsJSON(_ tables: StorageTableCounts) -> JSONValue {
    .obj([
        ("documents", .int(tables.documents)),
        ("document_sections", .int(tables.documentSections)),
        ("pages", .int(tables.pages)),
        ("roots", .int(tables.roots)),
        ("crawl_state", .int(tables.crawlState))
    ])
}

/// formatStorageStats (src/cli/formatters/storage.js): the bold headings, the
/// fixed-width labels, and the `Object.entries(result.tables)` listing (which
/// enumerates the pinned insertion order — all keys are non-integer-like).
func formatStorageStats(_ stats: StorageStatsEnvelope) -> String {
    var lines = [
        bold("Storage Breakdown"),
        "  Database:     \(formatBytes(stats.dbSize))",
        "  Raw JSON:     \(formatBytes(stats.rawJson.size)) (\(stats.rawJson.files) files)",
        "  Markdown:     \(formatBytes(stats.markdown.size)) (\(stats.markdown.files) files)",
        "  HTML cache:   \(formatBytes(stats.html.size)) (\(stats.html.files) files)",
        // `result.resources` is always set by this implementation, so the JS
        // conditional spread always includes the line.
        "  Resources:    \(formatBytes(stats.resources.size)) (\(stats.resources.files) files)",
        "  Total:        \(formatBytes(stats.total))",
        "",
        bold("Table Row Counts")
    ]
    lines.append("  documents: \(stats.tables.documents)")
    lines.append("  document_sections: \(stats.tables.documentSections)")
    lines.append("  pages: \(stats.tables.pages)")
    lines.append("  roots: \(stats.tables.roots)")
    lines.append("  crawl_state: \(stats.tables.crawlState)")
    return lines.joined(separator: "\n")
}

// MARK: - check-orphans (storageCheckOrphans in storage.js)

/// `{ fkViolations: [...rows], semanticOrphans: { crawlStateMissingRoot,
/// documentsMissingPage } }` — fkViolations rows serialize in engine column
/// order, exactly as JSON.stringify sees bun:sqlite's row objects.
func checkOrphansJSON(_ connection: StorageConnection) -> JSONValue {
    let violations = connection.foreignKeyCheck().map(dynamicRowJSON)
    return .obj([
        ("fkViolations", .array(violations)),
        (
            "semanticOrphans",
            .obj([
                ("crawlStateMissingRoot", .int(connection.crawlStateOrphanCount())),
                ("documentsMissingPage", .int(connection.documentsMissingPageCount()))
            ])
        )
    ])
}

/// A dynamic row as a JSON object: SELECT column order, cells typed as the
/// engine reported them. `.number` serializes through the encoder's ECMA-262
/// formatter (the `.javaScript` profiles), so a real round-trips exactly as
/// `JSON.stringify` prints bun:sqlite's number.
func dynamicRowJSON(_ row: DynamicRow) -> JSONValue {
    .obj(
        row.cells.map { cell in
            switch cell.value {
                case .text(let text): return (cell.name, .string(text))
                case .integer(let integer): return (cell.name, .int(integer))
                case .real(let double): return (cell.name, .number(double))
                case .null: return (cell.name, .null)
            }
        })
}

/// `JSON.stringify(value)` byte-for-byte — the compact form used by the
/// maintenance `summary(label)` human formatter. Total for the same reason as
/// `stringifyPretty` (non-finite → null, bounded nesting).
func stringifyCompact(_ value: JSONValue) -> String {
    // Total for these projections (non-finite → null, shallow nesting), so the encode never actually
    // throws; fall back to `null` rather than trapping if that invariant ever drifts.
    guard let bytes = try? value.encodedBytes(options: .javaScript) else { return "null" }
    return String(decoding: bytes, as: UTF8.self)
}
