import AppleDocsCore
import AppleDocsStorage
import AppleDocsWeb
import Foundation

/// Temporary on-disk corpus (database + resources) shared by the web UI and static-site tests.
struct WebCorpusFixture {
    let root: URL
    var databasePath: String { root.appendingPathComponent("corpus.db").path }
    var resourcesDirectory: String { root.appendingPathComponent("resources", isDirectory: true).path }

    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("apple-docs-webui-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try seedCorpus()
        try seedSymbols()
    }

    func remove() {
        try? FileManager.default.removeItem(at: root)
    }

    func responder(baseURL: String = "https://docs.example") -> WebHTTPResponder {
        WebHTTPResponder(
            databasePath: databasePath,
            resourcesDirectory: resourcesDirectory,
            site: WebSiteConfiguration(baseURL: baseURL)
        )
    }

    private func seedCorpus() throws {
        let store = try CorpusStore(path: databasePath, options: .readWrite)
        defer { store.close() }
        try store.upsertRoot(CorpusRootRecord(slug: "swiftui", displayName: "SwiftUI", kind: "framework", pageCount: 3))
        let view = try store.upsertDocument(
            DocumentRecord(
                key: try DocumentKey("swiftui/view"),
                title: "View",
                roleHeading: "Protocol",
                framework: "swiftui",
                abstractText: "A type that represents part of your app's user interface."
            )
        )
        try store.replaceSections(
            forDocumentID: view,
            sections: [
                DocumentSectionRecord(
                    sectionKind: "discussion",
                    heading: "Overview",
                    contentText:
                        "Use `body` to compose <b>views</b>.\n\n- First item\n- Second item\n\n```swift\nstruct A: View {}\n```"
                )
            ]
        )
        let text = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("swiftui/text"), title: "Text", framework: "swiftui")
        )
        try store.replaceSections(forDocumentID: text, sections: Self.importedSections)
        _ = try store.upsertDocument(
            DocumentRecord(key: try DocumentKey("swiftui/view/body-8kl5o"), title: "body", framework: "swiftui")
        )
        try store.connection.executeScript(
            """
            INSERT INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
            VALUES ('swiftui/view', 'swiftui/text', 'see_also', 'Related Views', 0),
                   ('swiftui/view', 'swiftui/missing', 'see_also', 'Related Views', 1),
                   ('swiftui/text', 'swiftui/view', 'child', 'Creating Text', 0)
            """
        )
        try store.connection.executeScript(
            """
            INSERT INTO sf_symbols (name, scope, keywords_json, codepoint) VALUES ('star.fill', 'public', '["favorite"]', 1);
            INSERT INTO apple_font_families (id, display_name, status) VALUES ('sf-pro', 'SF Pro', 'available');
            INSERT INTO apple_font_files (id, family_id, file_name, file_path, format)
            VALUES ('sf-pro-regular', 'sf-pro', 'SF-Pro.ttf', 'fonts/SF-Pro.ttf', 'ttf');
            """
        )
    }

    /// Bun-imported shape: flattened `content_text` plus structured `content_json`.
    private static let importedSections = [
        DocumentSectionRecord(
            sectionKind: "discussion",
            heading: "Overview",
            contentText: "Overview Displays text. flattened",
            contentJSON: #"""
                [{"type":"heading","text":"Overview","level":2},{"type":"paragraph","inlineContent":[
                {"type":"text","text":"Displays "},{"type":"codeVoice","code":"String"},{"type":"text","text":" values."}]}]
                """#,
            sortOrder: 0
        ),
        DocumentSectionRecord(
            sectionKind: "mentioned_in",
            heading: "Mentioned in",
            contentText: "Laying out views",
            contentJSON: #"[{"key":"swiftui/view","title":"Laying out views"}]"#,
            sortOrder: 1
        ),
        DocumentSectionRecord(sectionKind: "topics", heading: "Topics", contentText: "Creating Text View", sortOrder: 2)
    ]

    private func seedSymbols() throws {
        let dir = URL(fileURLWithPath: resourcesDirectory).appendingPathComponent("symbols/public", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let svg = #"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><path d="M0 0h10v10z"/></svg>"#
        try Data(svg.utf8).write(to: dir.appendingPathComponent("star.fill.svg"))
    }
}
