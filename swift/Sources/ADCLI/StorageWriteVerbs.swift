// The `storage` WRITE verbs — `gc`, `materialize`, `compact` — mirroring
// cli.js's maintenance dispatch (src/cli/maintenance.js dispatchStorage →
// src/commands/storage.js + storage-compact.js). Each opens the corpus through
// the crawl write path (SQLiteWriteConnection + migrate, the DocsDatabase boot
// sequence), prints the JS formatter on stdout (`--json` = the raw result
// object, JSON.stringify(…, null, 2)-identical), and streams the JS
// logger.info diagnostics to stderr as plain lines (the JS emits them as
// JSON-log lines; stderr diagnostics are not part of the parity surface).
// A `MaintenanceError` prints `Error: <message>` and exits 1 — the cli.js
// ValidationError catch contract.

import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

/// Shared run/emit plumbing for the maintenance verbs.
enum MaintenanceVerb {
    /// The stderr info logger (the JS ctx.logger.info seam).
    static func logInfo(_ message: String) {
        FileHandle.standardError.write(Data("\(message)\n".utf8))
    }

    /// Run `body`, mapping a thrown ``MaintenanceError`` to the cli.js catch:
    /// `Error: <message>` on stderr, exit 1.
    static func run<T>(_ body: () throws -> T) throws -> T {
        do {
            return try body()
        } catch let error as MaintenanceError {
            FileHandle.standardError.write(Data("Error: \(error.message)\n".utf8))
            throw ExitCode(1)
        }
    }

    /// ``run(_:)`` for the async maintenance verbs (`consolidate`).
    static func runAsync<T>(_ body: () async throws -> T) async throws -> T {
        do {
            return try await body()
        } catch let error as MaintenanceError {
            FileHandle.standardError.write(Data("Error: \(error.message)\n".utf8))
            throw ExitCode(1)
        }
    }
}

/// `ad-cli storage gc [--drop markdown,html] [--older-than N] [--no-vacuum]`
/// — drop rendered-output dirs, remove orphan crawl_state + stale activity
/// rows, VACUUM.
struct StorageGcCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "gc", abstract: "Garbage collect cached materializations and orphan rows.")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Categories to drop: markdown, html (comma-separated).")
    var drop: String?

    @Option(name: .customLong("older-than"), help: "Remove activity records older than this many days.")
    var olderThan: Int?

    @Flag(name: .customLong("no-vacuum"), help: "Skip database VACUUM after cleanup.")
    var noVacuum = false

    @Flag(name: .long, help: "Emit JSON instead of the human summary.")
    var json = false

    func run() throws {
        let db = try openCrawlCorpus(corpus.path)
        // The JS `--drop` split: comma-separated, each entry trimmed (no
        // empty-filter — only the exact names act anyway).
        let dropList =
            drop.map { $0.split(separator: ",", omittingEmptySubsequences: false).map(jsTrim) } ?? []
        let result = try MaintenanceVerb.run {
            try StorageGC.run(
                db, dataDir: (corpus.path as NSString).deletingLastPathComponent,
                drop: dropList, olderThan: olderThan, vacuum: !noVacuum, log: MaintenanceVerb.logInfo)
        }
        let value: JSONValue = .obj([
            ("droppedDirs", .array(result.droppedDirs.map(JSONValue.string))),
            ("orphansCleaned", .int(Int64(result.orphansCleaned))),
            ("vacuumed", .bool(result.vacuumed))
        ])
        print(json ? stringifyPretty(value) : formatStorageGc(result))
    }
}

/// formatStorageGc (src/cli/formatters/storage.js).
func formatStorageGc(_ result: StorageGC.Result) -> String {
    var lines = [bold("Garbage Collection")]
    if !result.droppedDirs.isEmpty {
        lines.append("  Dropped:   \(result.droppedDirs.joined(separator: ", "))")
    }
    lines.append("  Orphans:   \(result.orphansCleaned) removed")
    lines.append("  Vacuumed:  \(result.vacuumed ? "yes" : "no")")
    return lines.joined(separator: "\n")
}

/// `ad-cli storage materialize [--format markdown|html|raw-json] [--roots a,b]`
/// — force-materialize rendered files for all/filtered documents.
struct StorageMaterializeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "materialize", abstract: "Force-materialize rendered files (markdown/html/raw-json).")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Output format: markdown (default), html, or raw-json.")
    var format: String?

    @Option(name: .long, help: "Comma-separated root slugs to materialize (default: all documents).")
    var roots: String?

    @Flag(name: .long, help: "Emit JSON instead of the summary line.")
    var json = false

    func run() throws {
        let db = try openCrawlCorpus(corpus.path)
        // maintenance.js: only 'html'/'raw-json' pass through; anything else
        // (including absent) falls back to markdown.
        let resolved: StorageMaterialize.Format =
            switch format {
                case "html": .html
                case "raw-json": .rawJson
                default: .markdown
            }
        // `--roots` split: trimmed, empties dropped (the JS .filter(Boolean)).
        let rootList = roots.map { $0.split(separator: ",").map(jsTrim).filter { !$0.isEmpty } } ?? []
        let result = try MaintenanceVerb.run {
            try StorageMaterialize.run(
                db, dataDir: (corpus.path as NSString).deletingLastPathComponent,
                format: resolved, roots: rootList,
                log: MaintenanceVerb.logInfo, logError: MaintenanceVerb.logInfo)
        }
        let value = materializeJSON(result)
        print(json ? stringifyPretty(value) : "storage materialize: \(stringifyCompact(value))")
    }

    /// The per-branch JS return shapes, key order pinned.
    private func materializeJSON(_ result: StorageMaterialize.Result) -> JSONValue {
        switch result {
            case .rawJson(let materialized):
                return .obj([
                    ("format", .string("raw-json")), ("materialized", .int(Int64(materialized)))
                ])
            case .noSections(let format, let total):
                return .obj([
                    ("format", .string(format.rawValue)), ("materialized", .int(0)),
                    ("total", .int(Int64(total)))
                ])
            case .rendered(let materialized, let format):
                return .obj([
                    ("materialized", .int(Int64(materialized))), ("format", .string(format.rawValue))
                ])
        }
    }
}

/// `ad-cli storage compact [--force] [--keep-raw]` — compress sections, make
/// the body index contentless, drop raw payloads, switch to render-on-demand.
struct StorageCompactCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "compact", abstract: "Compact the install: compressed sections, contentless body index.")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .long, help: "Compact even a `prebuilt` install.")
    var force = false

    @Flag(name: .customLong("keep-raw"), help: "Retain the embedded raw payloads (document_raw).")
    var keepRaw = false

    @Flag(name: .long, help: "Emit JSON instead of the summary line.")
    var json = false

    func run() throws {
        let db = try openCrawlCorpus(corpus.path)
        let result = try MaintenanceVerb.run {
            try StorageCompact.run(
                db, force: force, keepRaw: keepRaw, now: jsIsoNow(), log: MaintenanceVerb.logInfo)
        }
        let value: JSONValue = .obj([
            ("status", .string(result.status)),
            ("sectionsCompressed", .int(Int64(result.sectionsCompressed))),
            ("rawDropped", .int(Int64(result.rawDropped))),
            ("profile", .string(result.profile))
        ])
        print(json ? stringifyPretty(value) : "storage compact: \(stringifyCompact(value))")
    }
}

/// JS `String.prototype.trim()` over a comma-split entry.
private func jsTrim(_ piece: Substring) -> String {
    piece.trimmingCharacters(in: .whitespacesAndNewlines)
}
