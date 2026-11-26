import AppleDocsCore
import AppleDocsSearch
import Testing

/// Expected values from Bun's `chunkDocument` / `quantizeI8` / `quantizeTo` (src/search/chunker.js, embedding.js).
@Suite("Document chunking and quantization (Bun parity)")
struct DocumentChunkerTests {
    @Test func `chunks the anchor, then windowed sections, skipping Bun's excluded kinds`() {
        let long = String(repeating: "Ünïcode 😀 text. ", count: 120)
        let sections = [
            DocumentSectionRecord(sectionKind: "abstract", contentText: "A view that displays a root view."),
            DocumentSectionRecord(
                sectionKind: "declaration",
                heading: "Declaration",
                contentText: "struct NavigationStack"
            ),
            DocumentSectionRecord(sectionKind: "Discussion", heading: "Overview", contentText: "  " + long + "  "),
            DocumentSectionRecord(sectionKind: "rest_endpoint", heading: "URL", contentText: "GET /x"),
            DocumentSectionRecord(sectionKind: "topics", heading: "Topics", contentText: ""),
            DocumentSectionRecord(sectionKind: "see_also", contentText: "Related\nNavigationPath")
        ]
        let chunks = DocumentChunker.chunks(
            title: "NavigationStack",
            abstract: "A view that displays a root view.",
            headings: "Overview Topics",
            sections: sections
        )
        #expect(chunks.map(\.utf16.count) == [67, 880, 880, 609, 22])
        #expect(chunks[0] == "NavigationStack. A view that displays a root view.. Overview Topics")
        #expect(chunks[1].hasPrefix("Overview. Ünïcode 😀 text."))
        // Bun's window ends on a lone high surrogate (JavaScript strings allow it); Swift strings carry U+FFFD.
        #expect(chunks[2].utf16.last == 0xFFFD)
        #expect(chunks[4] == "Related\nNavigationPath")

        #expect(
            DocumentChunker.chunks(
                title: "T",
                abstract: nil,
                headings: nil,
                sections: [DocumentSectionRecord(sectionKind: "abstract", contentText: "Kept when no abstract text")]
            ) == ["T", "Kept when no abstract text"]
        )
        let anchor = DocumentChunker.chunks(
            title: String(repeating: "x", count: 1_000),
            abstract: String(repeating: "y", count: 500),
            headings: nil,
            sections: []
        )
        #expect(anchor.map(\.utf16.count) == [1_200])
    }

    @Test func `quantizes to sign bits and to int8 with a float32 scale`() {
        let vector: [Float] = [0.5, -0.25, 0.125, -1.0, 0.003937008, -0.003937008, 0.0, 0.7]
        #expect(EmbeddingQuantizer.signBits(vector) == [213])
        #expect(EmbeddingQuantizer.int8(vector) == [64, 224, 16, 129, 0, 0, 0, 89, 4, 2, 1, 60])
    }
}
