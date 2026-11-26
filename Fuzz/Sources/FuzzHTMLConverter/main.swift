import AppleDocsContent
import AppleDocsCore

/// Arbitrary bytes as an HTML page (archive, WWDC, guidelines sources).
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let bytes = Array(UnsafeBufferPointer(start: data, count: size))
    guard let key = try? DocumentKey("fuzz/html") else { return 0 }
    _ = HTMLDocumentConverter.convert(html: bytes, key: key, sourceType: .appleArchive, fallbackTitle: "Fuzz")
    return 0
}
