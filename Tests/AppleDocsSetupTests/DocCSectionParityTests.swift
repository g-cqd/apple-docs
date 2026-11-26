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
}
