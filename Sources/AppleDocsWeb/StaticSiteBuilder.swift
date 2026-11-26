import AppleDocsCommands
import AppleDocsCore
import AppleDocsOutput
import AppleDocsStorage
import Foundation

/// Static site generator emitting a self-contained HTML + discovery + JSON bundle from a Swift v1 corpus.
public enum StaticSiteBuilder: Sendable {
    /// Summary of emitted files produced by ``build(databasePath:outputDirectory:framework:limit:)``.
    public struct BuildReport: Hashable, Sendable {
        public let frameworksExported: Int
        public let pagesExported: Int
        public let outputDirectory: String
    }

    /// Exports static HTML pages, `frameworks.json`, and well-known discovery files to `outputDirectory`.
    public static func build(
        databasePath: String,
        outputDirectory: String,
        framework: String? = nil,
        limit: Int = 1_000
    ) throws -> BuildReport {
        let store = try CorpusStore(path: databasePath, options: .readOnly)
        defer { store.close() }

        let outURL = URL(fileURLWithPath: outputDirectory, isDirectory: true).standardizedFileURL
        try FileManager.default.createDirectory(at: outURL, withIntermediateDirectories: true)

        let allFrameworks = try CorpusQueryService.listFrameworks(on: store)
        let frameworks =
            framework.map { slug in
                allFrameworks.filter { $0.slug.lowercased() == slug.lowercased() }
            } ?? allFrameworks

        try writeRootFiles(frameworks: frameworks, into: outURL)
        let exported = try exportDocuments(from: store, framework: framework, limit: limit, into: outURL)
        return BuildReport(
            frameworksExported: frameworks.count,
            pagesExported: exported,
            outputDirectory: outURL.path
        )
    }

    private static func writeRootFiles(frameworks: [PublicFrameworkSummary], into outURL: URL) throws {
        let fm = FileManager.default
        try writeUTF8(
            WebHTMLRenderer.renderIndexPage(frameworks: frameworks),
            to: outURL.appendingPathComponent("index.html")
        )
        try writeUTF8("User-agent: *\nAllow: /\n", to: outURL.appendingPathComponent("robots.txt"))

        let apiDir = outURL.appendingPathComponent("api", isDirectory: true)
        try fm.createDirectory(at: apiDir, withIntermediateDirectories: true)
        try writeUTF8(
            try PublicProjection.encodeJSON(frameworks, pretty: true),
            to: apiDir.appendingPathComponent("frameworks.json")
        )

        let wellKnown = outURL.appendingPathComponent(".well-known", isDirectory: true)
        try fm.createDirectory(at: wellKnown, withIntermediateDirectories: true)
        try writeUTF8(
            "Contact: https://github.com/g-cqd/apple-docs/security/advisories\n",
            to: wellKnown.appendingPathComponent("security.txt")
        )
    }

    private static func exportDocuments(
        from store: CorpusStore,
        framework: String?,
        limit: Int,
        into outURL: URL
    ) throws -> Int {
        let fm = FileManager.default
        let clampedLimit = max(1, min(limit, 50_000))
        let rows: [SQLiteRow] =
            if let fw = framework?.lowercased() {
                try store.connection.query(
                    "SELECT key FROM documents WHERE framework = ? ORDER BY url_depth ASC, key ASC LIMIT ?",
                    bindings: [.text(fw), .integer(Int64(clampedLimit))]
                )
            } else {
                try store.connection.query(
                    "SELECT key FROM documents ORDER BY url_depth ASC, key ASC LIMIT ?",
                    bindings: [.integer(Int64(clampedLimit))]
                )
            }

        var exported = 0
        for row in rows {
            guard let key = try? DocumentKey(try row.text(at: 0)),
                let detail = try CorpusQueryService.readDocument(key: key, on: store)
            else {
                continue
            }
            let pageDir =
                outURL
                .appendingPathComponent("doc", isDirectory: true)
                .appendingPathComponent(key.rawValue, isDirectory: true)
            try fm.createDirectory(at: pageDir, withIntermediateDirectories: true)
            try writeUTF8(WebHTMLRenderer.renderDocumentPage(detail), to: pageDir.appendingPathComponent("index.html"))
            exported += 1
        }
        return exported
    }

    private static func writeUTF8(_ content: String, to url: URL) throws {
        try Data(content.utf8).write(to: url, options: .atomic)
    }
}
