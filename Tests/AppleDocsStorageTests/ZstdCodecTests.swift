import AppleDocsCore
import AppleDocsStorage
import Testing

@Suite("ZstdCodec")
struct ZstdCodecTests {
    /// 64 × "SwiftUI NavigationStack overview content. " compressed by `zstd -19` (frame declares its size).
    private static let sizedFrame: [UInt8] = [
        0x28, 0xB5, 0x2F, 0xFD, 0x64, 0x80, 0x09, 0x8D, 0x01, 0x00, 0xA2, 0xC2, 0x09, 0x10, 0xC0, 0xB7,
        0x01, 0x32, 0x7D, 0x59, 0x8B, 0xB6, 0x6C, 0x07, 0x79, 0xE3, 0x5B, 0xEB, 0xD5, 0xE1, 0x04, 0xAE,
        0x78, 0xDD, 0xA3, 0xC6, 0xE4, 0x83, 0xBC, 0x64, 0xCE, 0x5E, 0xBA, 0x79, 0x2B, 0xC9, 0x26, 0x28,
        0x8C, 0x93, 0xEC, 0x0A, 0x01, 0x00, 0x9A, 0x52, 0xF3, 0x55, 0x19, 0x59, 0xEE, 0x87, 0xBC
    ]

    /// Same payload compressed from a pipe (`zstd -c < file`): the frame omits its content size.
    private static let streamingFrame: [UInt8] = [
        0x28, 0xB5, 0x2F, 0xFD, 0x04, 0x68, 0x8D, 0x01, 0x00, 0xA2, 0xC2, 0x09, 0x10, 0xC0, 0xB7, 0x01,
        0x32, 0x7D, 0x59, 0x8B, 0xB6, 0x6C, 0x07, 0x79, 0xE3, 0x5B, 0xEB, 0xD5, 0xE1, 0x04, 0xAE, 0x78,
        0xDD, 0xA3, 0xC6, 0xE4, 0x83, 0xBC, 0x64, 0xCE, 0x5E, 0xBA, 0x79, 0x2B, 0xC9, 0x26, 0x28, 0x8C,
        0x93, 0xEC, 0x0A, 0x01, 0x00, 0x9A, 0x52, 0xF3, 0x55, 0x19, 0x59, 0xEE, 0x87, 0xBC
    ]

    /// "Decompressed section body!" compressed by `zstd`.
    private static let smallFrame: [UInt8] = [
        0x28, 0xB5, 0x2F, 0xFD, 0x24, 0x1A, 0xD1, 0x00, 0x00, 0x44, 0x65, 0x63, 0x6F, 0x6D, 0x70, 0x72,
        0x65, 0x73, 0x73, 0x65, 0x64, 0x20, 0x73, 0x65, 0x63, 0x74, 0x69, 0x6F, 0x6E, 0x20, 0x62, 0x6F,
        0x64, 0x79, 0x21, 0xC7, 0xDF, 0x91, 0x11
    ]

    private static let expectedText = String(repeating: "SwiftUI NavigationStack overview content. ", count: 64)

    @Test func `decodes sized and streaming frames and passes plain text through`() throws {
        #expect(ZstdCodec.isZstdFrame(Self.sizedFrame))
        #expect(try ZstdCodec.decompress(Self.sizedFrame) == Array(Self.expectedText.utf8))
        #expect(try ZstdCodec.decompress(Self.streamingFrame) == Array(Self.expectedText.utf8))
        #expect(try ZstdCodec.decodeText(from: .blob(Self.streamingFrame)) == Self.expectedText)
        #expect(try ZstdCodec.decodeText(from: .text("plain")) == "plain")
        #expect(try ZstdCodec.decodeText(from: .null) == nil)
        #expect(try ZstdCodec.decompress(Array("not zstd".utf8)) == Array("not zstd".utf8))
    }

    @Test func `enforces the decoded size cap on both frame kinds and rejects corrupt frames`() {
        #expect(throws: SQLiteError.self) { _ = try ZstdCodec.decompress(Self.sizedFrame, maxDecodedBytes: 32) }
        #expect(throws: SQLiteError.self) { _ = try ZstdCodec.decompress(Self.streamingFrame, maxDecodedBytes: 32) }
        var corrupt = Self.sizedFrame
        corrupt[20] ^= 0xFF
        #expect(throws: SQLiteError.self) { _ = try ZstdCodec.decompress(corrupt) }
    }

    @Test func `CorpusStore reads Zstd-compressed document_sections blobs seamlessly`() throws {
        let store = try CorpusStore(path: ":memory:")
        let key = try DocumentKey("swiftui/navigationstack")
        let id = try store.upsertDocument(DocumentRecord(key: key, title: "NavigationStack"))
        try store.connection.execute(
            """
            INSERT INTO document_sections (document_id, section_kind, heading, content_text, sort_order)
            VALUES (?, 'overview', 'Overview', ?, 0)
            """,
            bindings: [.integer(id), .blob(Self.smallFrame)]
        )

        let sections = try store.sections(forKey: key)
        #expect(sections.count == 1)
        #expect(sections[0].contentText == "Decompressed section body!")
    }
}
