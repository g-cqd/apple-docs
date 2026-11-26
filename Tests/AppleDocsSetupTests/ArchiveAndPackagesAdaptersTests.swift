import AppleDocsContent
import AppleDocsCore
import AppleDocsSources
import Testing

@Suite("Archive & Package source adapters (AppleArchive, Packages)")
struct ArchiveAndPackagesAdaptersTests {
    @Test func `AppleArchiveAdapter parses JS-literal library.json and ingests HTML and PDF guides`() async throws {
        let transport = RecordingTransport()
        let libraryJS = """
            ({
              columns: { name: 0, type: 1, platform: 2, url: 3 },
              documents: [
                ["Cocoa Drawing Guide", 3, "macOS", "documentation/Cocoa/Conceptual/CocoaDrawingGuide/index.html"],
                ["PDF Guide", 3, "iOS", "documentation/General/Conceptual/PDFGuide/PDFGuide.pdf"],
                ["Sample", 5, "macOS", "samplecode/Ignored/index.html"]
              ]
            })
            """
        transport.set(AppleArchiveAdapter.libraryURL, body: libraryJS)
        transport.set(
            "https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CocoaDrawingGuide/index.html",
            body:
                "<html><head><title>Cocoa Drawing Guide</title></head><body><div id=\"contents\"><p>Drawing overview.</p></div></body></html>"
        )
        transport.set(
            "https://developer.apple.com/library/archive/documentation/General/Conceptual/PDFGuide/PDFGuide.pdf",
            body: ""
        )

        let client = UpstreamHTTPClient(transport: transport)
        let adapter = AppleArchiveAdapter()
        let discovery = try await adapter.discover(client: client, full: false)
        #expect(
            discovery.keys.map(\.rawValue).sorted() == [
                "apple-archive/documentation/cocoa/conceptual/cocoadrawingguide",
                "apple-archive/documentation/general/conceptual/pdfguide/pdfguide.pdf"
            ]
        )

        let htmlKey = try DocumentKey("apple-archive/documentation/cocoa/conceptual/cocoadrawingguide")
        if case .modified(let p, _, _) = try await adapter.fetch(key: htmlKey, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.kind == "archive-guide" && conv.document.framework == "cocoa")
        } else {
            Issue.record("expected modified HTML archive guide")
        }

        let pdfKey = try DocumentKey("apple-archive/documentation/general/conceptual/pdfguide/pdfguide.pdf")
        if case .modified(let p, _, _) = try await adapter.fetch(key: pdfKey, previousETag: nil, client: client),
            let conv = p.converted
        {
            #expect(conv.document.title == "PDF Guide" && conv.sections.first?.heading == "Original PDF")
        } else {
            Issue.record("expected modified PDF archive guide")
        }
    }

    @Test func `PackagesAdapter discovers official or full catalog and normalizes raw READMEs`() async throws {
        let transport = RecordingTransport()
        transport.set(
            "https://raw.githubusercontent.com/apple/swift-collections/main/README.md",
            body: "# Swift Collections\n\nData structures for Swift.\n\n## Usage\n\nImport `Collections`.",
            etag: "\"r1\""
        )
        let client = UpstreamHTTPClient(transport: transport)
        let adapter = PackagesAdapter()
        let official = try await adapter.discover(client: client, full: false)
        let keys = official.keys.map(\.rawValue)
        #expect(official.isPartial && keys.contains("packages/apple/swift-collections"))

        let key = try DocumentKey("packages/apple/swift-collections")
        guard case .modified(let payload, _, _) = try await adapter.fetch(key: key, previousETag: nil, client: client),
            let converted = payload.converted
        else {
            Issue.record("expected modified package")
            return
        }
        #expect(converted.document.kind == "package")
        #expect(converted.document.url == "https://github.com/apple/swift-collections")
        #expect(converted.document.abstractText == "Data structures for Swift.")
        #expect(converted.sections.contains { $0.heading == "Package Metadata" })
    }
}
