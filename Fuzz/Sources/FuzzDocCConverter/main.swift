import AppleDocsContent
import AppleDocsCore

/// Arbitrary bytes as DocC render JSON: conversion may throw on invalid JSON but must never trap, recurse
/// unboundedly, or produce relationships pointing at the page itself.
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let bytes = Array(UnsafeBufferPointer(start: data, count: size))
    guard let key = try? DocumentKey("fuzz/page"),
        let converted = try? DocCJSONConverter.convert(json: bytes, key: key)
    else { return 0 }
    precondition(!converted.relationships.contains { $0.toKey == key }, "self relationship")
    _ = BunMarkdownRenderer.render(
        BunMarkdownRenderer.Header(
            key: key.rawValue,
            title: converted.document.title,
            framework: "fuzz",
            role: nil,
            roleHeading: nil,
            platformsJSON: converted.document.platformsJSON
        ),
        sections: converted.sections
    )
    for section in converted.sections { _ = section.contentJSON.flatMap(StoredSectionContent.markdown(contentJSON:)) }
    return 0
}
