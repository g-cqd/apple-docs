// `ad-cli resources sync-fonts` — index Apple fonts into the corpus. The portable
// core of src/resources/apple-assets.js `syncAppleFonts`: the 8 Apple font families
// + system / already-extracted discovery + variable-axis inspection (FontInspect),
// upserted into apple_font_families / apple_font_files. The DMG download+extract half
// (hdiutil, macOS-only) is opt-in behind `--download-fonts`; the snapshot ships the
// extracted files, so the default (flag-off) run still yields the family + system rows.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// The `resources` command group — bundled Apple resource syncs (fonts, SF Symbols catalog + bake).
struct ResourcesCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "resources",
        abstract: "Sync bundled Apple resources (fonts, SF Symbols) into the corpus.",
        subcommands: [
            ResourcesSyncFontsCommand.self, ResourcesSyncSymbolsCommand.self,
            ResourcesPrerenderSymbolsCommand.self
        ])
}

/// `ad-cli resources sync-fonts [--db …] [--home …] [--json]`.
struct ResourcesSyncFontsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-fonts",
        abstract: "Discover + index Apple fonts into apple_font_families / apple_font_files.")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    @Flag(name: .long, help: "macOS-only: download + extract the Apple font DMGs (hdiutil) before indexing.")
    var downloadFonts = false

    func run() async throws {
        let dataDir =
            home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"]
            ?? "\(NSHomeDirectory())/.apple-docs"
        let dbPath = db ?? "\(dataDir)/apple-docs.db"
        guard let connection = StorageConnection(path: dbPath) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open corpus \(dbPath)\n".utf8))
            throw ExitCode(1)
        }
        let result = await FontSync.syncAppleFonts(
            connection, dataDir: dataDir, now: jsIsoNow(), downloadFonts: downloadFonts,
            warn: { message in FileHandle.standardError.write(Data("ad-cli: \(message)\n".utf8)) })
        if json {
            var pairs: [(String, JSONValue)] = [
                ("families", .int(Int64(result.families))),
                ("files", .int(Int64(result.files))),
                ("variable", .int(Int64(result.variable))),
                ("system", .int(Int64(result.system))),
                ("remote", .int(Int64(result.remote)))
            ]
            // The download counts are only meaningful under --download-fonts; keep the default
            // (flag-off) shape at the original five keys.
            if downloadFonts {
                pairs.append(("downloaded", .int(Int64(result.downloaded))))
                pairs.append(("extracted", .int(Int64(result.extracted))))
            }
            print(stringifyPretty(.obj(pairs)))
        } else {
            let base =
                "fonts: \(result.families) families, \(result.files) files "
                + "(\(result.variable) variable, \(result.system) system, \(result.remote) remote)"
            print(
                downloadFonts
                    ? base + ", \(result.downloaded) downloaded, \(result.extracted) extracted" : base)
        }
    }
}
