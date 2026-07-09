// `ad-cli prune [--dry-run] [--no-vacuum]` — trim the corpus to
// `<dataDir>/scope.json` without re-crawling (src/cli/maintenance.js
// dispatchPrune → src/commands/prune.js). Requires a scope.json (it defines
// what to KEEP); a missing/invalid scope or an unknown framework slug is the
// cli.js ValidationError contract (`Error: <message>`, exit 1). Human output
// is the maintenance `summary('prune')` line; `--json` is the summary object.

import ADBuilder
import ADBuilderPipeline
import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

struct PruneCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "prune", abstract: "Trim the corpus to <data-dir>/scope.json without re-crawling.")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .customLong("dry-run"), help: "Report what would be removed; change nothing.")
    var dryRun = false

    @Flag(name: .customLong("no-vacuum"), help: "Skip the VACUUM space-reclaim pass.")
    var noVacuum = false

    @Flag(name: .long, help: "Emit JSON instead of the summary line.")
    var json = false

    func run() throws {
        let db = try openCrawlCorpus(corpus.path)
        let dataDir = (corpus.path as NSString).deletingLastPathComponent
        let summary = try MaintenanceVerb.run { () throws -> Prune.Summary in
            // The scope's source names validate against the adapter registry
            // (JS getAdapterTypes()) — the native adapter set is the registry.
            guard
                let scope = try ScopeLoader.load(
                    dataDir: dataDir,
                    validSources: SourceRegistry.nativeAdapterTypes.map { $0.type },
                    log: MaintenanceVerb.logInfo)
            else {
                throw MaintenanceError(
                    "prune requires \(dataDir)/\(ScopeLoader.scopeFile) — it defines what to KEEP. "
                        + "See the README's \"Scoping the corpus\" section.")
            }
            return try Prune.run(
                db, dataDir: dataDir, scope: scope,
                options: Prune.Options(
                    dryRun: dryRun, noVacuum: noVacuum, now: jsIsoNow(),
                    pid: Int64(ProcessInfo.processInfo.processIdentifier), log: MaintenanceVerb.logInfo))
        }
        let value = pruneJSON(summary)
        print(json ? stringifyPretty(value) : "prune: \(stringifyCompact(value))")
    }

    /// The JS summary object, key order pinned.
    private func pruneJSON(_ summary: Prune.Summary) -> JSONValue {
        .obj([
            ("status", .string(summary.status)),
            ("rootsRemoved", .int(Int64(summary.rootsRemoved))),
            ("rootsKept", .int(Int64(summary.rootsKept))),
            ("pagesRemoved", .int(Int64(summary.pagesRemoved))),
            ("documentsRemoved", .int(Int64(summary.documentsRemoved))),
            ("filesRemoved", .int(Int64(summary.filesRemoved))),
            ("fontsDropped", .bool(summary.fontsDropped)),
            ("symbolsDropped", .bool(summary.symbolsDropped)),
            (
                "byRoot",
                .array(
                    summary.byRoot.map { entry in
                        .obj([
                            ("slug", .string(entry.slug)),
                            ("sourceType", entry.sourceType.map(JSONValue.string) ?? .null),
                            ("pages", .int(Int64(entry.pages)))
                        ])
                    })
            )
        ])
    }
}
