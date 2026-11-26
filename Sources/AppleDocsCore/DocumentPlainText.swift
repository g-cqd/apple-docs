/// Bun's `renderPlainText(document, sections)` (`content/render-text.js`): the text the body index and search
/// snippets are built from — title, abstract, declaration, headings, then each section's heading and text in
/// sort order, blank-line separated.
public enum DocumentPlainText {
    public static func render(
        title: String?,
        abstract: String?,
        declaration: String?,
        headings: String?,
        sections: [DocumentSectionRecord]
    ) -> String {
        let ordered = sections.enumerated()
            .sorted { ($0.element.sortOrder, $0.offset) < ($1.element.sortOrder, $1.offset) }
            .map(\.element)
        var parts = [title, abstract, declaration, headings]
            .compactMap { value -> String? in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
        for section in ordered {
            let body = [section.heading, section.contentText]
                .compactMap { value -> String? in
                    guard let value, !value.isEmpty else { return nil }
                    return value
                }
                .joined(separator: "\n")
            let trimmed = trim(body)
            if !trimmed.isEmpty { parts.append(trimmed) }
        }
        return trim(collapseNewlineRuns(parts.joined(separator: "\n\n")))
    }

    /// `/\n{3,}/g → "\n\n"`.
    private static func collapseNewlineRuns(_ text: String) -> String {
        var out: [UInt8] = []
        out.reserveCapacity(text.utf8.count)
        var run = 0
        for byte in text.utf8 {
            run = byte == 0x0A ? run + 1 : 0
            if run <= 2 { out.append(byte) }
        }
        return String(decoding: out, as: UTF8.self)
    }

    /// `String.prototype.trim()` (JavaScript `\s`).
    public static func trim(_ text: String) -> String {
        let scalars = text.unicodeScalars
        guard let first = scalars.firstIndex(where: { !isJSWhitespace($0) }) else { return "" }
        let last = scalars.lastIndex(where: { !isJSWhitespace($0) }) ?? first
        if first == scalars.startIndex, scalars.index(after: last) == scalars.endIndex { return text }
        return String(scalars[first ... last])
    }

    public static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
            case 0x09 ... 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                true
            default: false
        }
    }
}
