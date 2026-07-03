// AppleArchiveAdapter vs the bun oracle: the library.json JS-literal sanitize
// + catalog filter chain (keys/titles/urls/sourceMetadata pinned from running
// the REAL apple-archive.js discover over the same fixture), the key/url/
// framework helpers, and the fixed PDF pointer page.

import Foundation
import HTTPTypes
import Testing

@testable import ADBuilder

/// The synthetic library.json (a JS OBJECT LITERAL — parens, trailing commas,
/// bare keys) exercising every filter: resourceType, prefix, format,
/// KNOWN_MISSING, ../-prefix + #fragment normalize, index/parent-name key
/// folding, sibling preservation, dedupe, entity decoding.
private let libraryFixture = """
    ({
      columns: { name: 0, url: 1, type: 2, platform: 3, },
      documents: [
        ["Core Data Guide", "../documentation/Cocoa/Conceptual/CoreData/index.html", 3, "macOS",],
        ["Drag &amp; Drop <b>", "documentation/Cocoa/Conceptual/DragDrop/DragDrop.html#intro", 3, "OS X"],
        ["Sibling Page", "documentation/Cocoa/Conceptual/DragDrop/ch02.html", 3, null],
        ["Dupe Of Core Data", "documentation/Cocoa/Conceptual/CoreData/CoreData.html", 3, "macOS"],
        ["Numerics PDF (skipped)", "documentation/Performance/Conceptual/Mac_OSX_Numerics/Mac_OSX_Numerics.pdf", 3, "macOS"],
        ["A PDF Guide", "documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf", 3, "Carbon"],
        ["Sample (wrong type)", "documentation/Cocoa/SampleThing/index.html", 5, "macOS"],
        ["Outside prefix", "technotes/tn2000/index.html", 3, "macOS"],
        ["Featured", "featuredarticles/RoadMapiOS/index.html", 3, "iOS"],
        ["Weird format", "documentation/Cocoa/Conceptual/Thing/movie.mov", 3, "macOS"],
      ],
    })
    """

/// discovery.keys from bun over the same fixture.
private let expectedKeys = [
    "apple-archive/documentation/Cocoa/Conceptual/CoreData",
    "apple-archive/documentation/Cocoa/Conceptual/DragDrop",
    "apple-archive/documentation/Cocoa/Conceptual/DragDrop/ch02.html",
    "apple-archive/documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf",
    "apple-archive/featuredarticles/RoadMapiOS",
]

private let coreDataMetadataOracle =
    "{\"resourceType\":\"Guides\",\"platform\":\"macOS\",\"archivePath\":\"documentation/Cocoa/Conceptual/CoreData/index.html\",\"format\":\"html\"}"
private let siblingMetadataOracle =
    "{\"resourceType\":\"Guides\",\"platform\":null,\"archivePath\":\"documentation/Cocoa/Conceptual/DragDrop/ch02.html\",\"format\":\"html\"}"

@Test func archiveCatalogKeysAndDedupe() throws {
    let (entries, order) = try AppleArchiveAdapter.buildGuideCatalog(libraryFixture)
    #expect(order == expectedKeys)

    let coreData = entries["apple-archive/documentation/Cocoa/Conceptual/CoreData"]
    // Dedupe kept the FIRST entry (index.html), not the CoreData.html dupe.
    #expect(coreData?.title == "Core Data Guide")
    #expect(coreData?.format == "html")
    #expect(coreData?.sourceMetadata == coreDataMetadataOracle)
}

@Test func archiveCatalogEntitiesAndNullPlatform() throws {
    let (entries, _) = try AppleArchiveAdapter.buildGuideCatalog(libraryFixture)
    // Entity decoding (&amp; LAST) + fragment strip.
    let dragDrop = entries["apple-archive/documentation/Cocoa/Conceptual/DragDrop"]
    #expect(dragDrop?.title == "Drag & Drop <b>")
    #expect(dragDrop?.url == "https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/DragDrop/DragDrop.html")
    // null platform serializes as JSON null.
    let sibling = entries["apple-archive/documentation/Cocoa/Conceptual/DragDrop/ch02.html"]
    #expect(sibling?.sourceMetadata == siblingMetadataOracle)
}

@Test func archivePathAndUrlHelpers() {
    // pathToKey: index fold, parent-name fold, sibling preserved, pdf kept.
    #expect(
        AppleArchiveAdapter.pathToKey("documentation/A/B/index.html")
            == "apple-archive/documentation/A/B")
    #expect(AppleArchiveAdapter.pathToKey("documentation/A/B/b.HTML") == "apple-archive/documentation/A/B")
    #expect(
        AppleArchiveAdapter.pathToKey("documentation/A/B/ch02.html")
            == "apple-archive/documentation/A/B/ch02.html")
    #expect(
        AppleArchiveAdapter.pathToKey("documentation/A/B/guide.pdf")
            == "apple-archive/documentation/A/B/guide.pdf")

    // keyToFallbackUrl.
    #expect(
        AppleArchiveAdapter.keyToFallbackUrl("apple-archive/documentation/A/B")
            == "https://developer.apple.com/library/archive/documentation/A/B/index.html")
    #expect(
        AppleArchiveAdapter.keyToFallbackUrl("apple-archive/documentation/A/B/g.pdf")
            == "https://developer.apple.com/library/archive/documentation/A/B/g.pdf")

    // deriveFramework (pinned incl. the featuredarticles case).
    #expect(AppleArchiveAdapter.deriveFramework("apple-archive/documentation/Cocoa/Conceptual/CoreData") == "cocoa")
    #expect(AppleArchiveAdapter.deriveFramework("apple-archive/featuredarticles/RoadMapiOS") == "roadmapios")
    #expect(AppleArchiveAdapter.deriveFramework("apple-archive") == nil)

    // archiveFormat.
    #expect(AppleArchiveAdapter.archiveFormat("a/b.PDF") == "pdf")
    #expect(AppleArchiveAdapter.archiveFormat("a/b") == "html")
    #expect(AppleArchiveAdapter.archiveFormat("a.v2/b") == "html")
}

// Literals hoisted to file scope as typed `let` so the assertion below stays under the 100ms
// type-check budget (big string-literal arguments are the budget cost here).
private let pdfKey = "apple-archive/documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf"
private let pdfUrl =
    "https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf"
private let pdfSourceMetadata =
    "{\"resourceType\":\"Guides\",\"platform\":\"Carbon\",\"archivePath\":\"documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf\",\"format\":\"pdf\"}"
private let pdfExpectedContentText =
    "This archive guide is only available as a PDF.\n\nOpen the original document: https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/SomeGuide/SomeGuide.pdf"

@Test func archivePdfPageMatchesBunOracle() {
    let page = AppleArchiveAdapter.pdfPage(
        key: pdfKey, url: pdfUrl, framework: "carbon", title: "A PDF Guide",
        sourceMetadata: pdfSourceMetadata)
    #expect(page.document.title == "A PDF Guide")
    #expect(page.document.kind == "archive-guide")
    #expect(page.document.role == "article")
    #expect(page.document.framework == "carbon")
    #expect(page.document.urlDepth == 5)
    #expect(page.document.abstractText == "Archived PDF guide. Open the original PDF URL for the full document.")
    #expect(page.sections.count == 1)
    #expect(page.sections[0].sectionKind == "discussion")
    #expect(page.sections[0].heading == "Original PDF")
    #expect(page.sections[0].contentText == pdfExpectedContentText)
}

@Test func archiveDiscoverOverStubClient() async throws {
    let context = SourceContext(
        client: StubHTTPClient { request in
            #expect(request.head.url?.absoluteString.contains("library.json") == true)
            return httpResponse(200, body: libraryFixture)
        }, rateLimiter: instantRateLimiter())
    let adapter = AppleArchiveAdapter()
    let discovery = try await adapter.discover(context)
    #expect(discovery.keys == expectedKeys)
    #expect(discovery.roots.first?.slug == "apple-archive")
    #expect(discovery.roots.first?.kind == "collection")

    // check() is a frozen-archive no-op.
    let check = try await adapter.check("any", previousState: "\"e\"", context)
    #expect(check.status == .unchanged)
    #expect(!check.changed)
}

@Test func archiveHtmlNormalizeUsesContentsContainer() async throws {
    let context = SourceContext(
        client: StubHTTPClient { _ in httpResponse(200, body: libraryFixture) },
        rateLimiter: instantRateLimiter())
    let adapter = AppleArchiveAdapter()
    _ = try await adapter.discover(context)  // warm the catalog

    let html = """
        <html><head><title>Core Data Guide</title></head><body>
        <div id="nav"><p>chrome to ignore</p></div>
        <div id="contents"><h1>Core Data</h1><p>Managed objects.</p><h2>Stack</h2><p>Contexts.</p></div>
        </body></html>
        """
    let page = try adapter.normalize(
        "apple-archive/documentation/Cocoa/Conceptual/CoreData", .html(html))
    #expect(page.document.sourceType == "apple-archive")
    #expect(page.document.kind == "archive-guide")
    #expect(page.document.framework == "cocoa")
    #expect(page.document.url == "https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/CoreData/index.html")
    #expect(
        page.document.sourceMetadata
            == "{\"resourceType\":\"Guides\",\"platform\":\"macOS\",\"archivePath\":\"documentation/Cocoa/Conceptual/CoreData/index.html\",\"format\":\"html\"}")
    #expect(page.sections.contains { $0.heading == "Stack" && $0.contentText == "Contexts." })
    #expect(!page.sections.contains { $0.contentText?.contains("chrome to ignore") == true })
}
