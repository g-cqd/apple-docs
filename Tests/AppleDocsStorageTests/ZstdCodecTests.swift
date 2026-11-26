import AppleDocsCore
import AppleDocsStorage
import Testing

@Suite("ZstdCodec")
struct ZstdCodecTests {
    @Test func `compresses and decompresses section blobs transparently and enforces size caps`() throws {
        let text = String(repeating: "SwiftUI NavigationStack overview content. ", count: 64)
        let rawBytes = Array(text.utf8)
        let compressed = try ZstdCodec.compress(rawBytes)

        #expect(ZstdCodec.isZstdFrame(compressed))
        #expect(compressed.count < rawBytes.count)

        let decoded = try ZstdCodec.decompress(compressed)
        #expect(decoded == rawBytes)
        #expect(try ZstdCodec.decodeText(from: .blob(compressed)) == text)
        #expect(try ZstdCodec.decodeText(from: .text("plain")) == "plain")
        #expect(try ZstdCodec.decodeText(from: .null) == nil)

        // Decompression bomb protection
        #expect(throws: SQLiteError.self) {
            _ = try ZstdCodec.decompress(compressed, maxDecodedBytes: 32)
        }
    }

    @Test func `CorpusStore reads Zstd-compressed document_sections blobs seamlessly`() throws {
        let store = try CorpusStore(path: ":memory:")
        let key = try DocumentKey("swiftui/navigationstack")
        let id = try store.upsertDocument(DocumentRecord(key: key, title: "NavigationStack"))
        let compressed = try ZstdCodec.compress(Array("Decompressed section body!".utf8))
        try store.connection.execute(
            """
            INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
            VALUES (?, 'overview', 'Overview', ?, 0)
            """,
            bindings: [.integer(id), .blob(compressed)]
        )

        let sections = try store.sections(forKey: key)
        #expect(sections.count == 1)
        #expect(sections[0].contentText == "Decompressed section body!")
    }
}
