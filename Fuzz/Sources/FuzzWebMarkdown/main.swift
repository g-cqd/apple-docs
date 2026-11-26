import AppleDocsWeb

/// Stored Markdown rendered into HTML: whatever the input, every tag in the output must be one the renderer
/// authors, its attributes must be renderer-authored (`href`, `class`), and no `href` may use a script scheme.
/// Content `<` and `"` are escaped, so a literal `<` starts an authored tag and quotes delimit attribute values.
/// Tags are scanned over UTF-8 bytes like an HTML tokenizer (code points, not grapheme clusters: a combining mark
/// after `>` would otherwise fuse with it into one `Character`).
@_cdecl("LLVMFuzzerTestOneInput")
public func fuzz(_ data: UnsafePointer<UInt8>, _ size: Int) -> CInt {
    let text = String(decoding: UnsafeBufferPointer(start: data, count: size), as: UTF8.self)
    let html = WebHTMLRenderer.renderMarkdownFragment(text)
    for tag in html.utf8.split(separator: UInt8(ascii: "<")).dropFirst() {
        let body = String(decoding: tag.prefix { $0 != UInt8(ascii: ">") }, as: UTF8.self)
        let name = body.prefix { $0.isLetter || $0.isNumber || $0 == "/" }.lowercased()
        precondition(allowedTags.contains(name), "unexpected tag <\(body)>")
        for (attribute, value) in attributes(of: body.dropFirst(name.count)) {
            precondition(allowedAttributes.contains(attribute), "unexpected attribute \(attribute) in <\(body)>")
            precondition(!value.lowercased().hasPrefix("javascript:"), "script URL in <\(body)>")
            if attribute == "href" { precondition(value.hasPrefix("/doc/"), "foreign href in <\(body)>") }
        }
    }
    return 0
}

/// `name="value"` pairs, honoring double quotes; an unquoted or unterminated attribute is itself a violation.
private func attributes(of text: Substring) -> [(String, String)] {
    var pairs: [(String, String)] = []
    var rest = text.drop { $0 == " " }
    while !rest.isEmpty {
        let name = rest.prefix { $0 != "=" && $0 != " " }
        rest = rest.dropFirst(name.count)
        precondition(rest.hasPrefix("=\""), "unquoted attribute \(name)")
        rest = rest.dropFirst(2)
        guard let close = rest.firstIndex(of: "\"") else { preconditionFailure("unterminated attribute \(name)") }
        pairs.append((name.lowercased(), String(rest[..<close])))
        rest = rest[rest.index(after: close)...].drop { $0 == " " }
    }
    return pairs
}

private let allowedAttributes: Set<String> = ["href", "class"]
private let allowedTags: Set<String> = [
    "p", "/p", "h3", "/h3", "h4", "/h4", "h5", "/h5", "h6", "/h6", "pre", "/pre", "code", "/code", "ul", "/ul",
    "ol", "/ol", "li", "/li", "blockquote", "/blockquote", "table", "/table", "tbody", "/tbody", "tr", "/tr",
    "td", "/td", "strong", "/strong", "em", "/em", "a", "/a"
]
