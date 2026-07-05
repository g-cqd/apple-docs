// `ad-cli resources sync-fonts` — index Apple fonts into the corpus. The portable
// core of src/resources/apple-assets.js `syncAppleFonts`: the 8 Apple font families
// + system / already-extracted discovery + variable-axis inspection (FontInspect),
// upserted into apple_font_families / apple_font_files. The DMG download+extract half
// (hdiutil, macOS-only) is a deferred `--download-fonts` follow-up; the snapshot ships
// the extracted files, so a resync-skipped run still yields the family + system rows.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// The `resources` command group — bundled Apple resource syncs (fonts, later SF Symbols).
struct ResourcesCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "resources",
        abstract: "Sync bundled Apple resources (fonts, SF Symbols) into the corpus.",
        subcommands: [ResourcesSyncFontsCommand.self, ResourcesSyncSymbolsCommand.self])
}

/// `ad-cli resources sync-fonts [--db …] [--home …] [--json]`.
struct ResourcesSyncFontsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-fonts",
        abstract: "Discover + index Apple fonts into apple_font_families / apple_font_files.")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

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
        let result = FontSync.syncAppleFonts(connection, dataDir: dataDir, now: jsIsoNow())
        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("families", .int(Int64(result.families))),
                        ("files", .int(Int64(result.files))),
                        ("variable", .int(Int64(result.variable))),
                        ("system", .int(Int64(result.system))),
                        ("remote", .int(Int64(result.remote)))
                    ])))
        } else {
            let line =
                "fonts: \(result.families) families, \(result.files) files "
                + "(\(result.variable) variable, \(result.system) system, \(result.remote) remote)"
            print(line)
        }
    }
}
