import AppleDocsContent
import AppleDocsCore
import AppleDocsOutput
import Foundation
import Testing

@Suite("DocC section parity with the Bun corpus model")
struct DocCSectionParityTests {
    private static let payload = """
        {
            "identifier": {"interfaceLanguage": "swift"},
            "metadata": {"title": "Algorithm", "symbolKind": "enum", "roleHeading": "Enumeration"},
            "abstract": [
                {"type": "text", "text": "Algorithms used by "},
                {"type": "reference", "identifier": "doc://c/documentation/Compression/compression_encode_buffer"}
            ],
            "primaryContentSections": [
                {"kind": "declarations", "declarations": [{"tokens": [{"text": "enum Algorithm"}]}]},
                {"kind": "possibleValues", "values": [
                    {"name": "lzfse", "content": [{"type": "paragraph", "inlineContent": [{"type": "text", "text": "Apple's codec."}]}]}
                ]},
                {"kind": "mentions", "mentions": ["doc://c/documentation/Compression/compressing-files"]},
                {"kind": "content", "content": [
                    {"type": "heading", "text": "Choose an algorithm"},
                    {"type": "unorderedList", "items": [
                        {"content": [{"type": "paragraph", "inlineContent": [{"type": "text", "text": "Speed"}]}]},
                        {"content": [{"type": "paragraph", "inlineContent": [{"type": "strong", "inlineContent": [{"type": "text", "text": "Ratio"}]}]}]}
                    ]}
                ]}
            ],
            "topicSections": [{"title": "Codecs", "identifiers": ["doc://c/documentation/Compression/Algorithm/lzfse"]}],
            "relationshipsSections": [{"title": "Conforms To", "type": "conformsTo", "identifiers": ["doc://c/documentation/Swift/Sendable"]}],
            "seeAlsoSections": [{"title": "Related", "identifiers": ["doc://c/documentation/Compression/compression_encode_buffer"]}],
            "references": {
                "doc://c/documentation/Compression/compression_encode_buffer": {
                    "title": "compression_encode_buffer(_:_:_:_:_:_:)",
                    "url": "/documentation/compression/compression_encode_buffer(_:_:_:_:_:_:)"
                },
                "doc://c/documentation/Compression/compressing-files": {"title": "Compressing files", "url": "/documentation/compression/compressing-files"},
                "doc://c/documentation/Compression/Algorithm/lzfse": {"title": "lzfse", "url": "/documentation/compression/algorithm/lzfse"},
                "doc://c/documentation/Swift/Sendable": {"title": "Sendable", "url": "/documentation/swift/sendable"}
            }
        }
        """

    @Test func `emits every Bun section kind in Bun order with resolved reference titles`() throws {
        let converted = try DocCJSONConverter.convert(
            json: Array(Self.payload.utf8),
            key: try DocumentKey("compression/algorithm")
        )
        #expect(
            converted.sections.map(\.sectionKind) == [
                "abstract", "declaration", "possible_values", "mentioned_in",
                "discussion", "topics", "relationships", "see_also"
            ]
        )
        #expect(converted.sections.map(\.sortOrder) == Array(0 ..< 8))
        #expect(converted.document.abstractText == "Algorithms used by compression_encode_buffer(_:_:_:_:_:_:)")
        #expect(converted.document.declarationText == "enum Algorithm")

        let byKind = Dictionary(uniqueKeysWithValues: converted.sections.map { ($0.sectionKind, $0) })
        #expect(byKind["possible_values"]?.contentText == "- `lzfse`: Apple's codec.")
        #expect(byKind["mentioned_in"]?.contentText == "- Compressing files")
        #expect(byKind["discussion"]?.heading == "Choose an algorithm")
        #expect(byKind["discussion"]?.contentText == "- Speed\n- **Ratio**")
        #expect(byKind["topics"]?.contentText == "#### Codecs\n- lzfse")
        #expect(byKind["relationships"]?.contentText == "#### Conforms To\n- Sendable")
        #expect(!converted.sections.contains { $0.contentText.contains("doc://") })
        // Bun relation_type values.
        #expect(converted.relationships.map(\.relationType) == ["child", "conforms_to", "see_also"])
    }

    @Test func `rendered markdown does not duplicate abstract or declaration sections`() throws {
        let converted = try DocCJSONConverter.convert(
            json: Array(Self.payload.utf8),
            key: try DocumentKey("compression/algorithm")
        )
        let markdown = PublicDocumentDetail(document: converted.document, sections: converted.sections).renderMarkdown()
        #expect(markdown.components(separatedBy: "Algorithms used by").count == 2)
        #expect(markdown.components(separatedBy: "enum Algorithm").count == 2)
        #expect(markdown.contains("## Choose an algorithm"))
    }

    @Test func `discovers inline topic references with abstracts but skips stale empty-abstract duplicates`() throws {
        let json = """
            {
                "metadata": {"title": "Root"},
                "references": {
                    "doc://c/documentation/Kit/Live": {
                        "type": "topic", "url": "/documentation/kit/live#discussion",
                        "abstract": [{"type": "text", "text": "Real page."}]
                    },
                    "doc://c/documentation/Kit/Ghost": {"type": "topic", "url": "/documentation/kit/parent/ghost", "abstract": []},
                    "doc://c/documentation/Kit/Image": {"type": "image", "url": "/documentation/kit/image.png"},
                    "doc://com.externally.resolved.symbol/s:SS": {"type": "topic", "url": "/documentation/swift/string"}
                }
            }
            """
        let converted = try DocCJSONConverter.convert(json: Array(json.utf8), key: try DocumentKey("kit"))
        #expect(converted.discoveredKeys.map(\.rawValue) == ["kit/live"])
    }

    @Test func `keeps titled link groups that have no identifiers (Bun parity, CoreML regression)`() throws {
        let json = """
            {"metadata": {"title": "Guide"},
             "seeAlsoSections": [{"anchor": "Optimization", "generated": true, "identifiers": [], "title": "Optimization"}]}
            """
        let converted = try DocCJSONConverter.convert(json: Array(json.utf8), key: try DocumentKey("coreml/guide"))
        let seeAlso = converted.sections.first { $0.sectionKind == "see_also" }
        #expect(seeAlso?.contentText == "#### Optimization")
    }

    @Test func `a target listed in two topic groups keeps its last group, like Bun's upsert`() throws {
        let json = """
            {"metadata": {"title": "PDFSelection"},
             "topicSections": [
                {"title": "Getting Information", "identifiers": ["doc://p/documentation/PDFKit/PDFSelection/color"]},
                {"title": "Managing Drawing", "identifiers": ["doc://p/documentation/PDFKit/PDFSelection/color"]}],
             "references": {"doc://p/documentation/PDFKit/PDFSelection/color":
                {"title": "color", "url": "/documentation/pdfkit/pdfselection/color"}}}
            """
        let converted = try DocCJSONConverter.convert(
            json: Array(json.utf8),
            key: try DocumentKey("pdfkit/pdfselection")
        )
        #expect(converted.relationships.count == 1)
        #expect(converted.relationships.first?.section == "Managing Drawing")
        #expect(converted.relationships.first?.sortOrder == 1)
    }
}
