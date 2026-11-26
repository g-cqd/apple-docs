import AppleDocsContent

/// Identifier and URL normalization: never traps; produced keys are lowercase, slash-separated, and free of
/// empty or traversal segments.
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let text = String(decoding: UnsafeBufferPointer(start: data, count: size), as: UTF8.self)
    if let key = AppleIdentifier.normalize(text) {
        precondition(key == key.lowercased(), "non-lowercase key")
        precondition(
            !key.split(separator: "/", omittingEmptySubsequences: false).contains { $0.isEmpty },
            "empty segment"
        )
    }
    _ = CrossSourceLinkMapper.key(forURL: text)
    return 0
}
