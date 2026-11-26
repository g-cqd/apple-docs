import AppleDocsSearch

/// FTS5 query construction from user text: never traps and never emits an unbalanced double quote (which
/// would turn user input into FTS5 syntax). Quotes are counted per byte, as FTS5 reads them (a combining mark
/// after `"` would otherwise fuse with it into one `Character`).
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let text = String(decoding: UnsafeBufferPointer(start: data, count: size), as: UTF8.self)
    let lexical = FTSQueryBuilder.buildLexicalQuery(text)
    precondition(lexical.utf8.count(where: { $0 == UInt8(ascii: "\"") }) % 2 == 0, "unbalanced quotes: \(lexical)")
    let trigram = FTSQueryBuilder.sanitizeTrigramQuery(text)
    precondition(trigram.utf8.count(where: { $0 == UInt8(ascii: "\"") }) % 2 == 0, "unbalanced quotes: \(trigram)")
    return 0
}
