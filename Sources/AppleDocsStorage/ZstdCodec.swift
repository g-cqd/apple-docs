internal import HTTPZstd

/// Transparent Zstandard (`zstd`) decoder for compressed corpus section & raw payload blobs.
///
/// Backed by g-cqd/HTTP's `HTTPZstd` — the vendored libzstd (upstream v1.5.7) compiled into the binary, the same
/// copy the server's `zstd` content coding uses — so releases carry no dynamic `libzstd` dependency on macOS or Linux,
/// and the process holds one libzstd, not two.
///
/// Mirrors the Bun `section-codec.js` wire convention: blobs beginning with the 4-byte Zstd frame
/// magic (`28 B5 2F FD`) are decompressed with an explicit maximum output cap (`maxDecodedBytes`)
/// to prevent decompression bombs; plain UTF-8 text or unframed blobs pass through unchanged.
public enum ZstdCodec: Sendable {
    /// Maximum output size accepted during decompression (16 MiB default — Threat Model T-04).
    public static let defaultMaxDecodedBytes = 16_777_216

    ///Minimum UTF-8 byte length before trying Zstandard section compression (matches Bun `section-codec.js` intent).
    public static let minCompressBytes = 96

    /// Compresses `text` with Zstandard (level 3, pooled `HTTPZstd` context) when the frame is smaller than
    /// the raw UTF-8 bytes; otherwise returns `.text(text)` untouched.
    public static func encodeSectionText(_ text: String) -> SQLiteValue {
        let utf8Count = text.utf8.count
        guard utf8Count >= minCompressBytes else { return .text(text) }
        let raw = Array(text.utf8)
        if let compressed = try? Zstd.compress(raw), compressed.count < raw.count {
            return .blob(compressed)
        }
        return .text(text)
    }

    /// Optional variant of ``encodeSectionText(_:)`` for nullable `content_json` columns.
    public static func encodeOptionalSectionText(_ text: String?) -> SQLiteValue {
        guard let text else { return .null }
        return encodeSectionText(text)
    }

    /// Returns `true` when `bytes` starts with the standard Zstandard frame magic (`0x28 0xB5 0x2F 0xFD`).
    public static func isZstdFrame(_ bytes: [UInt8]) -> Bool {
        Zstd.isFrame(bytes)
    }

    /// Decompresses a Zstandard frame with a strict output cap (`maxDecodedBytes`); anything else passes through.
    public static func decompress(
        _ bytes: [UInt8],
        maxDecodedBytes: Int = defaultMaxDecodedBytes
    ) throws(SQLiteError) -> [UInt8] {
        guard isZstdFrame(bytes) else { return bytes }
        do {
            return try Zstd.decompress(bytes, maxOutputSize: maxDecodedBytes)
        } catch .outputLimitExceeded {
            throw .transactionFailed("Zstd frame exceeds max decoded size (\(maxDecodedBytes) bytes).")
        } catch {
            throw .transactionFailed("Zstd decompression failed: \(error).")
        }
    }

    /// Decodes a `document_sections` TEXT or Zstd-compressed BLOB into a UTF-8 `String`.
    public static func decodeText(
        from value: SQLiteValue,
        maxDecodedBytes: Int = defaultMaxDecodedBytes
    ) throws(SQLiteError) -> String? {
        switch value {
            case .null:
                return nil
            case .text(let string):
                return string
            case .blob(let bytes):
                let decoded = isZstdFrame(bytes) ? try decompress(bytes, maxDecodedBytes: maxDecodedBytes) : bytes
                return String(decoding: decoded, as: UTF8.self)
            default:
                throw .typeMismatch(column: 0, expected: "TEXT|BLOB?")
        }
    }
}
