import AppleDocsContent
import AppleDocsCore

/// Arbitrary bytes as a Markdown page with optional YAML front matter (Swift Evolution, Swift Book sources).
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let bytes = Array(UnsafeBufferPointer(start: data, count: size))
    guard let key = try? DocumentKey("fuzz/markdown") else { return 0 }
    _ = MarkdownDocumentConverter.convert(markdown: bytes, key: key, sourceType: .swiftEvolution, fallbackTitle: "Fuzz")
    return 0
}
