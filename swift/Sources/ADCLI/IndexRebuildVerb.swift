// `ad-cli index rebuild [body|trigram]` — rebuild a search index from
// existing data (src/cli/maintenance.js dispatchIndex → src/commands/
// index-rebuild.js). The target defaults to `body`; an unknown target prints
// the JS dispatch error and exits 1. Human output is the maintenance
// `summary('index rebuild <target>')` line; `--json` is the raw result.
// Note the body rebuild's lite-tier/empty-corpus refusals are RESULTS
// (`{status:'error',message}`), not failures — the JS returns them and
// exits 0.

import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

struct IndexRebuildCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "rebuild", abstract: "Rebuild the body or trigram FTS5 index from existing data.")

    @Argument(help: "Index to rebuild: body (default) or trigram.")
    var target: String = "body"

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .long, help: "Emit JSON instead of the summary line.")
    var json = false

    func run() throws {
        guard target == "body" || target == "trigram" else {
            FileHandle.standardError.write(
                Data("Unknown index rebuild target: \(target) (expected \"body\" or \"trigram\")\n".utf8))
            throw ExitCode(1)
        }
        let db = try openCrawlCorpus(corpus.path)

        let value: JSONValue
        if target == "trigram" {
            let result = try MaintenanceVerb.run {
                try IndexRebuild.rebuildTrigram(db, log: MaintenanceVerb.logInfo)
            }
            value = .obj([("status", .string(result.status)), ("indexed", .int(Int64(result.indexed)))])
        } else {
            let result = try MaintenanceVerb.run {
                try IndexRebuild.rebuildBody(db, now: jsIsoNow(), log: MaintenanceVerb.logInfo)
            }
            switch result {
                case .indexed(let counts):
                    value = .obj([
                        ("indexed", .int(Int64(counts.indexed))),
                        ("total", .int(Int64(counts.total))),
                        ("errors", .int(Int64(counts.errors)))
                    ])
                case .error(let message):
                    value = .obj([("status", .string("error")), ("message", .string(message))])
            }
        }
        print(json ? stringifyPretty(value) : "index rebuild \(target): \(stringifyCompact(value))")
    }
}
