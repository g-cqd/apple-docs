// `ad-cli resources sync-symbols` — sync the SF Symbol catalog. Ports the catalog
// half of src/resources/apple-symbols/sync.js `syncSfSymbols`: reads the CoreGlyphs
// bundle plists into sf_symbols. macOS-only (the bundle lives under SFSymbols.framework);
// the prerender-to-SVG half is a separate later step.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// `ad-cli resources sync-symbols [--db --home --scope --json]`.
struct ResourcesSyncSymbolsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-symbols",
        abstract: "Sync the SF Symbol catalog from CoreGlyphs.bundle into sf_symbols (macOS).")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

    @Option(name: .long, help: "Symbol scope: public (default) or private.")
    var scope: String = "public"

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let dataDir =
            home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"]
            ?? "\(NSHomeDirectory())/.apple-docs"
        let dbPath = db ?? "\(dataDir)/apple-docs.db"
        guard let connection = StorageConnection(path: dbPath) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open corpus \(dbPath)\n".utf8))
            throw ExitCode(1)
        }
        let count = SymbolSync.syncSfSymbols(connection, scope: scope, now: jsIsoNow())
        if json {
            print(
                stringifyPretty(
                    .obj([("scope", .string(scope)), ("symbols", .int(Int64(count)))])))
        } else {
            print("symbols: \(count) \(scope) entries synced")
        }
    }
}
