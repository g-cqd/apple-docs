import AppleDocsCore
import Foundation

/// Renders the Markdown subset produced by the DocC/HTML content converters into escaped HTML.
///
/// Supported: paragraphs, `#`-headings (clamped to `h3`…`h6` under the page's `h1`/`h2`), fenced code,
/// `-`/`N.` lists, `>` asides, `|` tables, and inline `` `code` ``, `**strong**`, `*em*`. Every piece of
/// text is HTML-escaped before markup is added, so stored content can never inject markup or script.
enum WebMarkdownBlockRenderer {
    static func render(_ text: String) -> String {
        var state = BlockState()
        var fence: (language: String, lines: [Substring])?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if var open = fence {
                if line.hasPrefix("```") {
                    state.emitCode(open.lines.joined(separator: "\n"), language: open.language)
                    fence = nil
                } else {
                    open.lines.append(line)
                    fence = open
                }
                continue
            }
            if line.hasPrefix("```") {
                state.flush()
                fence = (String(line.dropFirst(3)).trimmingASCIIWhitespace, [])
                continue
            }
            state.consume(line)
        }
        if let open = fence { state.emitCode(open.lines.joined(separator: "\n"), language: open.language) }
        state.flush()
        return state.output.joined(separator: "\n")
    }

    /// Escapes `raw` and applies inline code, strong, and emphasis markup.
    static func renderInline(_ raw: some StringProtocol) -> String {
        var out = ""
        for (index, segment) in raw.split(separator: "`", omittingEmptySubsequences: false).enumerated() {
            out +=
                index.isMultiple(of: 2)
                ? linked(segment) : "<code>\(WebHTMLRenderer.escapeHTML(String(segment)))</code>"
        }
        return out
    }

    /// Escapes `text` and turns `[title](document/key)` references (as stored by the content normalizer) into
    /// `/doc/<key>` links; the target must be a valid ``DocumentKey`` (balanced parentheses allowed).
    private static func linked(_ text: some StringProtocol) -> String {
        var out = ""
        var rest = Substring(text)
        while let open = rest.firstIndex(of: "["), let close = rest[open...].firstIndex(of: "]"),
            rest.index(after: close) < rest.endIndex, rest[rest.index(after: close)] == "(",
            let end = matchingParenthesis(in: rest, from: rest.index(after: close))
        {
            let title = rest[rest.index(after: open) ..< close]
            let target = rest[rest.index(close, offsetBy: 2) ..< end]
            out += emphasize(WebHTMLRenderer.escapeHTML(String(rest[..<open])))
            if let key = try? DocumentKey(String(target)) {
                out +=
                    "<a href=\"/doc/\(WebHTMLRenderer.escapeHTML(WebDocPath.safeKey(key.rawValue)))\">"
                    + emphasize(WebHTMLRenderer.escapeHTML(String(title))) + "</a>"
            } else {
                out += emphasize(WebHTMLRenderer.escapeHTML(String(rest[open ... end])))
            }
            rest = rest[rest.index(after: end)...]
        }
        return out + emphasize(WebHTMLRenderer.escapeHTML(String(rest)))
    }

    /// Index of the `)` closing the `(` at `start`, counting nested parentheses.
    private static func matchingParenthesis(in text: Substring, from start: Substring.Index) -> Substring.Index? {
        var depth = 0
        var index = start
        while index < text.endIndex {
            switch text[index] {
                case "(": depth += 1
                case ")":
                    depth -= 1
                    if depth == 0 { return index }
                default: break
            }
            index = text.index(after: index)
        }
        return nil
    }

    private static func emphasize(_ escaped: String) -> String {
        let strong = toggle(escaped, marker: "**", open: "<strong>", close: "</strong>")
        return toggle(strong, marker: "*", open: "<em>", close: "</em>")
    }

    private static func toggle(_ text: String, marker: String, open: String, close: String) -> String {
        let parts = text.components(separatedBy: marker)
        guard parts.count >= 3 else { return text }
        var out = parts[0]
        let pairedCount = parts.count.isMultiple(of: 2) ? parts.count - 1 : parts.count
        for index in 1 ..< parts.count {
            if index >= pairedCount {
                out += marker + parts[index]
            } else {
                out += (index.isMultiple(of: 2) ? close : open) + parts[index]
            }
        }
        return out
    }
}

/// Accumulates consecutive lines into one open block and emits HTML when the block kind changes.
private struct BlockState {
    private enum Kind { case none, paragraph, unordered, ordered, quote, table }

    private(set) var output: [String] = []
    private var kind = Kind.none
    private var lines: [String] = []

    mutating func consume(_ line: Substring) {
        let trimmed = line.trimmingASCIIWhitespace
        if trimmed.isEmpty { return flush() }
        if let level = headingLevel(trimmed) {
            flush()
            let text = trimmed.drop(while: { $0 == "#" }).trimmingASCIIWhitespace
            output.append("<h\(level)>\(WebMarkdownBlockRenderer.renderInline(text))</h\(level)>")
        } else if trimmed.hasPrefix("- ") || trimmed.hasPrefix("* ") {
            append(String(trimmed.dropFirst(2)), as: .unordered)
        } else if let item = orderedItem(trimmed) {
            append(item, as: .ordered)
        } else if trimmed.hasPrefix(">") {
            append(String(trimmed.dropFirst()).trimmingASCIIWhitespace, as: .quote)
        } else if trimmed.hasPrefix("|") {
            append(trimmed, as: .table)
        } else {
            append(trimmed, as: kind == .unordered || kind == .ordered ? kind : .paragraph, continuation: true)
        }
    }

    mutating func emitCode(_ code: String, language: String) {
        flush()
        let safeLanguage = language.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "+" }
        let attribute = language.isEmpty || !safeLanguage ? "" : " class=\"language-\(language)\""
        output.append("<pre><code\(attribute)>\(WebHTMLRenderer.escapeHTML(code))</code></pre>")
    }

    mutating func flush() {
        defer {
            kind = .none
            lines.removeAll(keepingCapacity: true)
        }
        switch kind {
            case .none: return
            case .paragraph:
                output.append("<p>\(WebMarkdownBlockRenderer.renderInline(lines.joined(separator: " ")))</p>")
            case .quote:
                output.append(
                    "<blockquote><p>\(WebMarkdownBlockRenderer.renderInline(lines.joined(separator: " ")))</p></blockquote>"
                )
            case .unordered, .ordered:
                let tag = kind == .ordered ? "ol" : "ul"
                let items = lines.map { "<li>\(WebMarkdownBlockRenderer.renderInline($0))</li>" }.joined()
                output.append("<\(tag)>\(items)</\(tag)>")
            case .table: output.append(renderTable())
        }
    }

    private mutating func append(_ text: String, as newKind: Kind, continuation: Bool = false) {
        if continuation, newKind == kind, newKind != .paragraph, let last = lines.popLast() {
            lines.append("\(last) \(text)")
            return
        }
        if newKind != kind { flush() }
        kind = newKind
        lines.append(text)
    }

    private func headingLevel(_ line: String) -> Int? {
        let hashes = line.prefix(while: { $0 == "#" }).count
        guard (1 ... 6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return min(6, max(3, hashes))
    }

    private func orderedItem(_ line: String) -> String? {
        let digits = line.prefix(while: \.isNumber)
        guard !digits.isEmpty, digits.count <= 4, line.dropFirst(digits.count).hasPrefix(". ") else { return nil }
        return String(line.dropFirst(digits.count + 2))
    }

    private func renderTable() -> String {
        let rows = lines.compactMap { line -> [String]? in
            let cells = line.split(separator: "|", omittingEmptySubsequences: false).dropFirst().dropLast()
                .map { $0.trimmingASCIIWhitespace }
            let isSeparator = cells.allSatisfy { cell in !cell.isEmpty && cell.allSatisfy { "-: ".contains($0) } }
            return cells.isEmpty || isSeparator ? nil : cells
        }
        let body = rows.map { row in
            "<tr>" + row.map { "<td>\(WebMarkdownBlockRenderer.renderInline($0))</td>" }.joined() + "</tr>"
        }
        return "<table><tbody>\(body.joined())</tbody></table>"
    }
}

extension StringProtocol {
    /// The receiver without leading/trailing ASCII spaces and tabs.
    fileprivate var trimmingASCIIWhitespace: String {
        var view = Substring(self)
        while let first = view.first, first == " " || first == "\t" || first == "\r" { view = view.dropFirst() }
        while let last = view.last, last == " " || last == "\t" || last == "\r" { view = view.dropLast() }
        return String(view)
    }
}
