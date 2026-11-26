import CAppleDocsZstd

/// Transparent Zstandard (`zstd`) codec for compressed corpus section & raw payload blobs.
///
/// Mirrors the Bun `section-codec.js` wire convention: blobs beginning with the 4-byte Zstd frame
/// magic (`28 B5 2F FD`) are decompressed with an explicit maximum output cap (`maxDecodedBytes`)
/// to prevent decompression bombs; plain UTF-8 text or unframed blobs pass through unchanged.
public enum ZstdCodec: Sendable {
    /// Maximum output size accepted during decompression (16 MiB default — Threat Model T-04).
    public static let defaultMaxDecodedBytes = 16_777_216

    /// Returns `true` when `bytes` starts with the standard Zstandard frame magic (`0x28 0xB5 0x2F 0xFD`).
    public static func isZstdFrame(_ bytes: [UInt8]) -> Bool {
        bytes.count >= 4
            && bytes[0] == 0x28
            && bytes[1] == 0xB5
            && bytes[2] == 0x2F
            && bytes[3] == 0xFD
    }

    /// Compresses `bytes` with Zstandard at `level` (default `3`).
    public static func compress(_ bytes: [UInt8], level: Int32 = 3) throws(SQLiteError) -> [UInt8] {
        try runBufferTransform(
            input: bytes,
            outputCapacity: ZSTD_compressBound(bytes.count),
            label: "compression"
        ) { dst, src in
            unsafe ZSTD_compress(dst.baseAddress, dst.count, src.baseAddress, src.count, level)
        }
    }

    /// Decompresses a Zstandard frame with a strict output cap (`maxDecodedBytes`).
    public static func decompress(
        _ bytes: [UInt8],
        maxDecodedBytes: Int = defaultMaxDecodedBytes
    ) throws(SQLiteError) -> [UInt8] {
        guard isZstdFrame(bytes) else { return bytes }
        let frameSize = bytes.withUnsafeBytes { raw in
            unsafe ZSTD_getFrameContentSize(raw.baseAddress, raw.count)
        }
        let errorSentinel = UInt64.max - 1
        let unknownSentinel = UInt64.max
        if frameSize == errorSentinel {
            throw .transactionFailed("Corrupt Zstd frame header.")
        }
        if frameSize != unknownSentinel {
            guard frameSize <= UInt64(maxDecodedBytes) else {
                throw .transactionFailed("Zstd frame exceeds max decoded size (\(maxDecodedBytes) bytes).")
            }
            let expected = Int(frameSize)
            if expected == 0 { return [] }
            return try runBufferTransform(input: bytes, outputCapacity: expected, label: "decompression") { dst, src in
                unsafe ZSTD_decompress(dst.baseAddress, dst.count, src.baseAddress, src.count)
            }
        }
        return try decompressStreaming(bytes, maxDecodedBytes: maxDecodedBytes)
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

    private static func runBufferTransform(
        input: [UInt8],
        outputCapacity: Int,
        label: String,
        operation: (UnsafeMutableRawBufferPointer, UnsafeRawBufferPointer) -> Int
    ) throws(SQLiteError) -> [UInt8] {
        var output = [UInt8](repeating: 0, count: outputCapacity)
        let written = output.withUnsafeMutableBytes { dst in
            input.withUnsafeBytes { src in
                unsafe operation(dst, src)
            }
        }
        guard ZSTD_isError(written) == 0 else {
            let reason = unsafe String(cString: ZSTD_getErrorName(written))
            throw .transactionFailed("Zstd \(label) failed: \(reason)")
        }
        if written < output.count {
            output.removeSubrange(written ..< output.count)
        }
        return output
    }

    private static func decompressStreaming(_ bytes: [UInt8], maxDecodedBytes: Int) throws(SQLiteError) -> [UInt8] {
        guard let dstream = unsafe ZSTD_createDStream() else {
            throw .transactionFailed("Unable to allocate Zstd decompression stream.")
        }
        defer { _ = unsafe ZSTD_freeDStream(dstream) }
        _ = unsafe ZSTD_initDStream(dstream)

        var output: [UInt8] = []
        let chunkSize = max(16_384, ZSTD_DStreamOutSize())
        var scratch = [UInt8](repeating: 0, count: chunkSize)

        var inputPos = 0
        while inputPos < bytes.count {
            var produced = 0
            let status: Int = bytes.withUnsafeBytes { src in
                var inBuf = unsafe ZSTD_inBuffer(src: src.baseAddress, size: src.count, pos: inputPos)
                let rc: Int = scratch.withUnsafeMutableBytes { dst in
                    var outBuf = unsafe ZSTD_outBuffer(dst: dst.baseAddress, size: dst.count, pos: 0)
                    let code = unsafe ZSTD_decompressStream(dstream, &outBuf, &inBuf)
                    produced = outBuf.pos
                    return code
                }
                inputPos = inBuf.pos
                return rc
            }
            guard ZSTD_isError(status) == 0 else {
                let reason = unsafe String(cString: ZSTD_getErrorName(status))
                throw .transactionFailed("Zstd stream decompression failed: \(reason)")
            }
            if produced > 0 {
                output.append(contentsOf: scratch[0 ..< produced])
            }
            guard output.count <= maxDecodedBytes else {
                throw .transactionFailed("Zstd stream exceeded max decoded size (\(maxDecodedBytes) bytes).")
            }
            if status == 0 { break }
        }
        return output
    }
}
