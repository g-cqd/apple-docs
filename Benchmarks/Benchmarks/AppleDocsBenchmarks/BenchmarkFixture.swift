import AppleDocsCore
import AppleDocsStorage
import Foundation

/// A deterministic synthetic corpus (documents with sections and relationships across a few frameworks), built
/// once per benchmark process in a temporary directory.
enum BenchmarkFixture {
    static let documentCount = 20_000
    static let frameworks = ["swiftui", "uikit", "foundation", "coreml", "pdfkit"]
    static let words = [
        "view", "stack", "navigation", "model", "data", "path", "layout", "text", "image", "button", "list", "grid",
        "scroll", "animation", "gesture", "state", "binding", "observable", "environment", "preference", "shape"
    ]

    static let databasePath: String = {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("apple-docs-bench-\(getpid())")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let path = directory.appendingPathComponent("corpus.db").path
        try? FileManager.default.removeItem(atPath: path)
        do {
            try build(at: path)
        } catch {
            fatalError("benchmark fixture: \(error)")
        }
        return path
    }()

    /// Title of document `index` (two pseudo-random camel-case words; deterministic).
    static func title(_ index: Int) -> String {
        let first = words[(index * 7) % words.count]
        let second = words[(index * 13 + 5) % words.count]
        return first.prefix(1).uppercased() + first.dropFirst() + second.prefix(1).uppercased() + second.dropFirst()
            + (index % 3 == 0 ? "" : String(index))
    }

    static func key(_ index: Int) -> String {
        "\(frameworks[index % frameworks.count])/\(title(index).lowercased())"
    }

    private static func build(at path: String) throws {
        let store = try CorpusStore(path: path, options: .readWrite)
        defer { store.close() }
        try store.connection.transaction {
            for framework in frameworks {
                try store.upsertRoot(
                    CorpusRootRecord(slug: framework, displayName: framework.uppercased(), kind: "framework")
                )
            }
            for index in 0 ..< documentCount {
                let id = try store.upsertDocument(
                    DocumentRecord(
                        key: try DocumentKey(key(index)),
                        title: title(index),
                        kind: "symbol",
                        roleHeading: index % 2 == 0 ? "Structure" : "Instance Method",
                        framework: frameworks[index % frameworks.count],
                        abstractText:
                            "A \(words[index % words.count]) that manages \(words[(index + 3) % words.count]) state.",
                        declarationText: "struct \(title(index))"
                    )
                )
                try store.replaceSections(
                    forDocumentID: id,
                    sections: [
                        DocumentSectionRecord(sectionKind: "abstract", contentText: "A \(title(index)).", sortOrder: 0),
                        DocumentSectionRecord(
                            sectionKind: "discussion",
                            heading: "Overview",
                            contentText: String(
                                repeating: "Use \(title(index)) to present \(words[index % words.count]). ",
                                count: 20
                            ),
                            sortOrder: 4
                        )
                    ]
                )
                try store.connection.execute(
                    "INSERT OR REPLACE INTO crawl_state (path, status, root_slug, depth) VALUES (?, 'done', ?, 1)",
                    bindings: [.text(key(index)), .text(frameworks[index % frameworks.count])]
                )
            }
        }
    }
}
