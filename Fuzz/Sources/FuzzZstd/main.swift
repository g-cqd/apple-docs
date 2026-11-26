import AppleDocsStorage

/// The vendored zstd decoder on hostile frames: errors are fine, traps and over-cap output are not.
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    var bytes: [UInt8] = [0x28, 0xB5, 0x2F, 0xFD]  // steer most inputs into the frame decoder
    bytes.append(contentsOf: UnsafeBufferPointer(start: data, count: size))
    if let decoded = try? ZstdCodec.decompress(bytes, maxDecodedBytes: 1 << 20) {
        precondition(decoded.count <= 1 << 20, "decoded size cap exceeded")
    }
    return 0
}
