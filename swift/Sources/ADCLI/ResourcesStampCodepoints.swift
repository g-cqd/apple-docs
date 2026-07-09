// `ad-cli resources stamp-codepoints` — the last F3 piece. Ports the standalone-phase
// half of src/resources/apple-symbols/codepoint-stamp.js `stampSfSymbolCodepoints`:
// extract each PUBLIC symbol's Unicode PUA codepoint from SF Symbols.app's private
// CoreGlyphsLib framework (the obfuscated catalog font is only readable via
// `Crypton.decryptObfuscatedFontTable`) and stamp `sf_symbols.codepoint` +
// `codepoint_version`. Additive, idempotent metadata; PUBLIC symbols only.
//
// Acquisition scope: this verb RESOLVES an installed SF Symbols.app — an authoritative
// `--app-path` override, else `/Applications/SF Symbols.app` / `SF Symbols Beta.app`,
// else the `<home>/cache/sf-symbols` download cache — the on-disk half of the JS
// `ensureSfSymbolsApp`. The network DMG download (install.js) is NOT driven from here:
// on target hosts SF Symbols.app is installed, and where it is not, `--app-path` points
// at any bundle. No app resolved → warn + stamp nothing + exit 0 (never a crash), so a
// bare snapshot host keeps whatever codepoints shipped in the snapshot.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// `ad-cli resources stamp-codepoints [--db --home --app-path --json]`.
struct ResourcesStampCodepointsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "stamp-codepoints",
        abstract: "Stamp SF Symbol Unicode codepoints from SF Symbols.app's CoreGlyphsLib (macOS).")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

    @Option(name: .long, help: "Override SF Symbols.app discovery with an explicit bundle path.")
    var appPath: String?

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let dataDir =
            home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"]
            ?? "\(NSHomeDirectory())/.apple-docs"
        let dbPath = db ?? "\(dataDir)/apple-docs.db"
        // writable: stamping IS a write pass; the default read connection is PRAGMA query_only
        // post-pivot, under which every UPDATE silently fails.
        guard let connection = StorageConnection(path: dbPath, writable: true) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open corpus \(dbPath)\n".utf8))
            throw ExitCode(1)
        }
        let result = SfSymbolCodepointStamp.stamp(
            connection, dataDir: dataDir, appPath: appPath,
            warn: { message in FileHandle.standardError.write(Data("ad-cli: \(message)\n".utf8)) },
            info: { message in FileHandle.standardError.write(Data("\(message)\n".utf8)) })

        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("stamped", .int(Int64(result.stamped))),
                        ("total", .int(Int64(result.total))),
                        ("fontPath", result.fontPath.map(JSONValue.string) ?? .null),
                        ("version", result.version.map(JSONValue.string) ?? .null)
                    ])))
        } else {
            print(humanSummary(result))
        }
    }

    /// A one-line human summary: the coverage headline, or the graceful-skip notice.
    private func humanSummary(_ result: SfSymbolCodepointStamp.Result) -> String {
        guard result.fontPath != nil else {
            return "codepoints: SF Symbols.app not available; skipped (0 stamped)"
        }
        let percent =
            result.total == 0 ? "0.0" : String(format: "%.1f", Double(result.stamped) * 100 / Double(result.total))
        let versionTag = result.version.map { " [SF Symbols \($0)]" } ?? ""
        return "codepoints: stamped \(result.stamped) of \(result.total) public symbols "
            + "(\(percent)% coverage)\(versionTag)"
    }
}
