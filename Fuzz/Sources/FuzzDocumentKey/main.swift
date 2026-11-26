import AppleDocsCore

/// `DocumentKey` validation must reject or accept any byte string without trapping, and accepted keys must be
/// stable (re-validating the raw value yields the same key) and free of traversal segments.
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let text = String(decoding: UnsafeBufferPointer(start: data, count: size), as: UTF8.self)
    guard let key = try? DocumentKey(text) else { return 0 }
    precondition((try? DocumentKey(key.rawValue))?.rawValue == key.rawValue, "unstable key")
    precondition(!key.rawValue.split(separator: "/").contains(".."), "traversal accepted")
    _ = key.rootSlug
    return 0
}
