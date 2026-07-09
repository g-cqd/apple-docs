// The section content codec — the native port of `src/storage/section-codec.js`
// (the `compact` storage profile's cell format). `storage compact` zstd-compresses
// `document_sections.content_text` / `content_json` in place; compression is
// opportunistic (a value is stored compressed only when that actually saves
// bytes, so small sections stay plain strings), which makes decoding fully
// type-directed and backward-compatible: TEXT passes through, a BLOB is a zstd
// frame (magic 28 b5 2f fd) inflated — or plain UTF-8 bytes as a best-effort
// fallback, exactly like `decodeSectionContent`.
//
// The encoder compresses at zstd level 3 — the library default
// (`ZSTD_CLEVEL_DEFAULT`), which is what `Bun.zstdCompressSync` uses when the
// JS codec omits the level. The exact frame bytes may still differ from a
// Bun-compacted corpus (different zstd builds/parameters), which is fine: the
// format contract is the type split (TEXT vs zstd BLOB), not the frame bytes.

import ADArchive
public import ADStorage

/// Encode/decode `document_sections` content cells (section-codec.js).
public enum SectionCodec {
    /// `encodeSectionContent(text)`: nil → NULL, empty → `''`, else the zstd
    /// frame when it is strictly smaller than the UTF-8 bytes, else the string.
    public static func encode(_ text: String?) -> SQLiteValue {
        guard let text else { return .null }
        if text.isEmpty { return .text("") }
        let raw = Array(text.utf8)
        if let compressed = ZstdEncoder.compress(raw, level: 3), compressed.count < raw.count {
            return .blob(compressed)
        }
        return .text(text)
    }

    /// `decodeSectionContent(value)`: TEXT passes through; a BLOB with the zstd
    /// magic is inflated; any other BLOB decodes as UTF-8 bytes; NULL → nil.
    public static func decodeText(_ value: SQLiteValue?) -> String? {
        switch value {
            case .text(let text):
                return text
            case .blob(let bytes):
                if bytes.count >= 4, bytes[0] == 0x28, bytes[1] == 0xB5, bytes[2] == 0x2F, bytes[3] == 0xFD,
                    let inflated = ZstdDecoder.decompress(bytes)
                {
                    return String(decoding: inflated, as: UTF8.self)
                }
                return String(decoding: bytes, as: UTF8.self)
            default:
                return nil
        }
    }
}
