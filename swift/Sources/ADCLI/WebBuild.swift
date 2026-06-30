// `ad-cli web build` — the native static-site build (P7 / WS-C). Opens the corpus
// read-only, bridges it to the ADWebBuild orchestrator via a `CorpusReader`
// adapter, and writes the artifact tree. This first slice emits the site
// essentials (landing + discovery + per-framework metadata + manifest); the
// per-document render loop + search/sitemap/assets are stubbed (logged to stderr
// from the BuildResult ledger). Parity oracle: `bun run cli.js web build`.

import ADJSONCore
import ADStorage
import ADWebBuild
import ArgumentParser
import Foundation

/// Bridges a corpus `StorageConnection` to the build's `CorpusReader`.
struct StorageCorpusReader: CorpusReader {
    let connection: StorageConnection

    func corpusRoots() -> [CorpusRoot] {
        // GAP (homepage parity): the JS homepage also drops roots whose only page
        // is the root itself (page_count filter) and reads doc_count from getRoots;
        // here documentCount = active page count. The corpus gate flags any diff.
        connection.listFrameworkRoots(kind: nil).map {
            CorpusRoot(slug: $0.slug, displayName: $0.name, kind: $0.kind, documentCount: Int($0.pageCount))
        }
    }

    /// GAP (fonts JSON parity): the /fonts embedded payload must byte-match
    /// `JSON.stringify(db.listAppleFonts())`; that serialization is a follow-up.
    /// Until then the fonts page renders its empty shell.
    func fontFamilies() -> JSON? { nil }

    func symbolTotals() -> [(scope: String, count: Int)] { connection.symbolScopeTotals() }
}

/// Writes the artifact tree under `outDir` (creating parent directories).
struct FileArtifactSink {
    let outDir: String

    func ensureDir(_ relative: String) throws {
        let path = relative.isEmpty ? outDir : "\(outDir)/\(relative)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    func write(_ artifact: Artifact) throws {
        let path = "\(outDir)/\(artifact.path)"
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: path, contents: Data(artifact.bytes)) else {
            throw ValidationError("ad-cli: failed to write \(path)")
        }
    }
}

/// `ad-cli web …` — the static-site build verb group.
struct WebCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "web", abstract: "Static documentation site build.",
        subcommands: [WebBuildCommand.self])
}

/// `ad-cli web build --db <PATH> [--out dist/web] [--base-url …] [--site-name …]`.
struct WebBuildCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "build",
        abstract: "Build the static site essentials (per-document render loop is WIP).")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Output directory.")
    var out: String = "dist/web"

    @Option(name: .customLong("base-url"), help: "Public base URL used in templates.")
    var baseUrl: String = ""

    @Option(name: .customLong("site-name"), help: "Site name.")
    var siteName: String = "Apple Developer Docs"

    @Option(name: .customLong("app-version"), help: "Package version (for the MCP server card).")
    var appVersion: String?

    @Flag(name: .customLong("skip-docs"), help: "Build only site essentials (the only mode supported so far).")
    var skipDocs = false

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            throw ExitCode(1)
        }
        let buildDate = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        let config = SiteConfig(baseUrl: baseUrl, siteName: siteName, bundled: true, buildDate: buildDate)
        let reader = StorageCorpusReader(connection: connection)
        let sink = FileArtifactSink(outDir: out)

        let result = try BuildSite.writeEssentials(
            config: config, reader: reader, version: appVersion,
            ensureDir: { try sink.ensureDir($0) }, write: { try sink.write($0) })

        var report = "ad-cli: built site essentials → \(out)\n"
        report += "ad-cli: still stubbed (per the build ledger):\n"
        for stub in result.stubs { report += "  - \(stub)\n" }
        FileHandle.standardError.write(Data(report.utf8))
    }
}
