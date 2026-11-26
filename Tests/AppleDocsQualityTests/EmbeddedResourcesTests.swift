import Foundation
import Testing

@Suite("Embedded resources")
struct EmbeddedResourcesTests {
    private static let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent()

    /// Each `Embedded*.swift` must contain its `Resources/` file verbatim (regenerate with
    /// `Scripts/embed-resources.py`); the binary ships no resource bundles.
    @Test(arguments: [
        ("AppleDocsStorage", "schema-v1-corpus.sql", "EmbeddedCorpusSchema"),
        ("AppleDocsStorage", "schema-v1-assets.sql", "EmbeddedAssetSchema"),
        ("AppleDocsMCP", "mcp-tools.json", "EmbeddedMCPTools"),
        ("AppleDocsSources", "sources.json", "EmbeddedSourceRegistry"),
        ("AppleDocsWeb", "style.css", "EmbeddedStylesheet"),
        ("AppleDocsWeb", "app.js", "EmbeddedScript")
    ])
    func `generated source embeds its resource verbatim`(target: String, resource: String, typeName: String) throws {
        let sources = Self.root.appendingPathComponent("Sources/\(target)")
        let original = try String(contentsOf: sources.appendingPathComponent("Resources/\(resource)"), encoding: .utf8)
        let generated = try String(contentsOf: sources.appendingPathComponent("\(typeName).swift"), encoding: .utf8)
        #expect(generated.contains("enum \(typeName) {"))
        // swift-format's layout: every non-empty line indented 8 spaces (stripped by Swift with the closing
        // delimiter's indentation); an empty last line keeps the file's trailing newline in the value.
        let indented = original.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.isEmpty ? "" : "        " + $0 }.joined(separator: "\n")
        #expect(generated.contains("    static let text = #\"\"\"\n" + indented + "\n        \"\"\"#\n"))
    }

    @Test func `no target ships a SwiftPM resource bundle`() throws {
        let manifest = try String(contentsOf: Self.root.appendingPathComponent("Package.swift"), encoding: .utf8)
        let shipped = manifest.components(separatedBy: "testTarget(").first ?? manifest
        #expect(!shipped.contains("resources:"))
    }
}
