// Lightweight Markdown → HTML — native, regex-free port of
// `src/content/render-html/markdown.js`. Used for the abstract/discussion
// fallback when DocC `contentJson` is absent (swift-book / WWDC / Swift-Evolution
// raw `.md`, HTML-source article intros). ADContent is Foundation-free, so the
// JS regexes are replicated as hand-rolled scanners (a build-time path).

enum HtmlMarkdown {
    static let maxBlockquoteDepth = 32

    /// markdownToHtml(md, _depth).
    static func markdownToHtml(_ md: String, depth: Int = 0, highlight: CodeHighlight? = nil) -> String {
        if md.isEmpty { return "" }
        let cleaned = JsString.trim(stripXmlPIs(md))
        if cleaned.isEmpty { return "" }

        let lines = cleaned.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var out = ""
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = JsString.trim(line)

            if trimmed.isEmpty {
                i += 1
                continue
            }

            // HTML comment — skip until '-->'
            if trimmed.hasPrefix("<!--") {
                while i < lines.count && !lines[i].contains("-->") { i += 1 }
                i += 1
                continue
            }

            // Fenced code block (``` or ~~~)
            if let fence = fenceMarker(line) {
                let lang = fence.lang.isEmpty ? "swift" : fence.lang
                var codeLines: [String] = []
                i += 1
                while i < lines.count && !lines[i].hasPrefix(fence.delim) {
                    codeLines.append(lines[i])
                    i += 1
                }
                i += 1  // skip closing fence
                out += renderFence(codeLines.joined(separator: "\n"), lang: lang, highlight: highlight)
                continue
            }

            // ATX heading  /^(#{1,6})\s+(.*)$/
            if let h = atxHeading(line) {
                if !h.text.isEmpty { out += "<h\(h.level)>\(inlineMarkdown(h.text))</h\(h.level)>" }
                i += 1
                continue
            }

            // Blockquote  ('> ' or '>')
            if line.hasPrefix("> ") || line == ">" {
                var quoteLines: [String] = []
                while i < lines.count && (lines[i].hasPrefix("> ") || lines[i] == ">") {
                    quoteLines.append(stripQuotePrefix(lines[i]))
                    i += 1
                }
                let inner = quoteLines.joined(separator: "\n")
                if depth >= maxBlockquoteDepth {
                    out += "<blockquote><p>\(inlineMarkdown(JsString.trim(collapseNewlines(inner))))</p></blockquote>"
                } else {
                    out += "<blockquote>\(markdownToHtml(inner, depth: depth + 1, highlight: highlight))</blockquote>"
                }
                continue
            }

            // Unordered list  /^[-*+]\s+/
            if isUnorderedItem(line) {
                var items: [String] = []
                while i < lines.count && isUnorderedItem(lines[i]) {
                    items.append(stripListPrefix(lines[i], ordered: false))
                    i += 1
                }
                out += "<ul>" + items.map { "<li>\(inlineMarkdown($0))</li>" }.joined() + "</ul>"
                continue
            }

            // Ordered list  /^\d+[.)]\s+/
            if isOrderedItem(line) {
                var items: [String] = []
                while i < lines.count && isOrderedItem(lines[i]) {
                    items.append(stripListPrefix(lines[i], ordered: true))
                    i += 1
                }
                out += "<ol>" + items.map { "<li>\(inlineMarkdown($0))</li>" }.joined() + "</ol>"
                continue
            }

            // Horizontal rule  /^[-*_]{3,}\s*$/
            if isThematicBreak(line) {
                out += "<hr>"
                i += 1
                continue
            }

            // Paragraph — collect consecutive non-special lines.
            var paraLines: [String] = []
            while i < lines.count && isParagraphLine(lines[i]) {
                paraLines.append(lines[i])
                i += 1
            }
            if !paraLines.isEmpty {
                out += "<p>\(inlineMarkdown(paraLines.joined(separator: " ")))</p>"
            } else {
                i += 1  // defense-in-depth: never spin on a line no branch consumed
            }
        }
        return out
    }

    /// inlineMarkdown(text) — the sequential inline passes, in JS order.
    static func inlineMarkdown(_ text: String) -> String {
        let pre = replaceDocRefs(text)
        var s = RenderHelpers.escapeHtml(pre)
        s = replacePlaceholders(s)  // &lt;#name#&gt;
        s = replaceImages(s)  // ![alt](url) → <em>[alt]</em> | ''
        s = removeAll(s, "![]")
        s = removeEmptyLinks(s)  // []()
        s = removeAll(s, "[]")
        s = replaceLinks(s)  // [text](url)
        s = wrapPairs(s, "***", "<strong><em>", "</em></strong>")
        s = wrapPairs(s, "___", "<strong><em>", "</em></strong>")
        s = wrapPairs(s, "**", "<strong>", "</strong>")
        s = wrapPairs(s, "__", "<strong>", "</strong>")
        s = wrapPairs(s, "*", "<em>", "</em>")
        s = wrapUnderscoreItalic(s)  // _x_ with non-alnum boundaries
        s = wrapPairs(s, "`", "<code>", "</code>")
        return s
    }

    // MARK: - block helpers

    /// Remove `<?…?>` XML processing instructions (`[^?]*` middle).
    private static func stripXmlPIs(_ md: String) -> String {
        guard md.contains("<?") else { return md }
        var out = ""
        let chars = Array(md)
        var i = 0
        while i < chars.count {
            if chars[i] == "<", i + 1 < chars.count, chars[i + 1] == "?" {
                var j = i + 2
                while j < chars.count && chars[j] != "?" { j += 1 }
                if j + 1 < chars.count && chars[j] == "?" && chars[j + 1] == ">" {
                    i = j + 2
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    private static func fenceMarker(_ line: String) -> (delim: String, lang: String)? {
        let chars = Array(line)
        guard let first = chars.first, first == "`" || first == "~" else { return nil }
        var n = 0
        while n < chars.count && chars[n] == first { n += 1 }
        guard n >= 3 else { return nil }
        // `\w*` info string (ASCII word chars).
        var lang = ""
        var k = n
        while k < chars.count, isWordChar(chars[k]) {
            lang.append(chars[k])
            k += 1
        }
        return (String(repeating: first, count: n), lang)
    }

    private static func renderFence(_ code: String, lang: String, highlight: CodeHighlight?) -> String {
        // DocC `<#name#>` placeholder round-trip across the highlighter.
        var placeholders: [String] = []
        let tokenized = replaceDoccPlaceholders(code) { name in
            let idx = placeholders.count
            placeholders.append(name)
            return "DoccPh\(idx)DoccPh"
        }
        var block =
            highlight?(tokenized, lang)
            ?? "<pre><code class=\"language-\(RenderHelpers.escapeHtml(lang))\">\(RenderHelpers.escapeHtml(tokenized))</code></pre>"
        block = restoreDoccPlaceholders(block, placeholders)
        return block
    }

    /// `^(#{1,6})\s+(.*)$` → (level, trimmed text). level = min(hashes+1, 6).
    private static func atxHeading(_ line: String) -> (level: Int, text: String)? {
        let chars = Array(line)
        var hashes = 0
        while hashes < chars.count && chars[hashes] == "#" { hashes += 1 }
        guard hashes >= 1 && hashes <= 6 else { return nil }
        guard hashes < chars.count, isJsWhitespace(chars[hashes]) else { return nil }
        var k = hashes
        while k < chars.count, isJsWhitespace(chars[k]) { k += 1 }
        let rest = String(chars[k...])
        return (min(hashes + 1, 6), JsString.trim(rest))
    }

    private static func stripQuotePrefix(_ line: String) -> String {
        // /^>\s?/ — '>' then an optional single whitespace.
        guard line.hasPrefix(">") else { return line }
        let afterGt = line.dropFirst()
        if let f = afterGt.first, isJsWhitespace(f) { return String(afterGt.dropFirst()) }
        return String(afterGt)
    }

    private static func isUnorderedItem(_ line: String) -> Bool {
        let chars = Array(line)
        guard let first = chars.first, first == "-" || first == "*" || first == "+" else { return false }
        return chars.count > 1 && isJsWhitespace(chars[1])
    }

    private static func isOrderedItem(_ line: String) -> Bool {
        let chars = Array(line)
        var k = 0
        while k < chars.count, chars[k] >= "0", chars[k] <= "9" { k += 1 }
        guard k >= 1, k < chars.count, chars[k] == "." || chars[k] == ")" else { return false }
        return k + 1 < chars.count && isJsWhitespace(chars[k + 1])
    }

    private static func stripListPrefix(_ line: String, ordered: Bool) -> String {
        let chars = Array(line)
        var k = 0
        if ordered {
            while k < chars.count, chars[k] >= "0", chars[k] <= "9" { k += 1 }
            k += 1  // the . or )
        } else {
            k = 1  // the bullet
        }
        while k < chars.count, isJsWhitespace(chars[k]) { k += 1 }
        return String(chars[k...])
    }

    /// `^[-*_]{3,}\s*$` — 3+ of -,*,_ then only whitespace.
    private static func isThematicBreak(_ line: String) -> Bool {
        let chars = Array(line)
        var k = 0
        while k < chars.count, chars[k] == "-" || chars[k] == "*" || chars[k] == "_" { k += 1 }
        guard k >= 3 else { return false }
        while k < chars.count, isJsWhitespace(chars[k]) { k += 1 }
        return k == chars.count
    }

    /// The JS paragraph-collector guard (note `^>\s`, `^#{1,6}\s` — slightly
    /// different from the block detectors above).
    private static func isParagraphLine(_ line: String) -> Bool {
        if JsString.trim(line).isEmpty { return false }
        if fenceMarker(line) != nil { return false }
        if isHashSpace(line) { return false }  // ^#{1,6}\s
        if isGtSpace(line) { return false }  // ^>\s
        if isUnorderedItem(line) { return false }
        if isOrderedItem(line) { return false }
        if isThematicBreak(line) { return false }
        if JsString.trim(line).hasPrefix("<!--") { return false }
        return true
    }

    private static func isHashSpace(_ line: String) -> Bool {
        let chars = Array(line)
        var k = 0
        while k < chars.count && chars[k] == "#" { k += 1 }
        guard k >= 1 && k <= 6 else { return false }
        return k < chars.count && isJsWhitespace(chars[k])
    }

    private static func isGtSpace(_ line: String) -> Bool {
        let chars = Array(line)
        return chars.first == ">" && chars.count > 1 && isJsWhitespace(chars[1])
    }

    private static func collapseNewlines(_ s: String) -> String {
        String(s.map { $0 == "\n" ? " " : $0 })  // /\n+/g handled via trim+single; approx for the >32 cap path
    }

    // MARK: - inline scanners

    /// `<doc:page(#section)?>` → `[display](/docs/swift-book/?q=encoded)`.
    private static func replaceDocRefs(_ text: String) -> String {
        guard text.contains("<doc:") else { return text }
        let chars = Array(text)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, "<doc:") {
                var j = i + 5
                var page = ""
                while j < chars.count, chars[j] != ">", chars[j] != "#" {
                    page.append(chars[j])
                    j += 1
                }
                if !page.isEmpty {
                    var section: String? = nil
                    if j < chars.count, chars[j] == "#" {
                        var sec = ""
                        var k = j + 1
                        while k < chars.count, chars[k] != ">" {
                            sec.append(chars[k])
                            k += 1
                        }
                        if !sec.isEmpty {
                            section = sec
                            j = k
                        }
                    }
                    if j < chars.count, chars[j] == ">" {
                        let pageSpaced = page.replacingDashes()
                        let display = section.map { "\(pageSpaced) — \($0.replacingDashes())" } ?? pageSpaced
                        out += "[\(display)](/docs/swift-book/?q=\(encodeURIComponent(page)))"
                        i = j + 1
                        continue
                    }
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `&lt;#name#&gt;` → placeholder span (name is non-`#`, ≥1, non-greedy).
    private static func replacePlaceholders(_ s: String) -> String {
        guard s.contains("&lt;#") else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, "&lt;#") {
                var j = i + 5
                var name = ""
                while j < chars.count, chars[j] != "#" {
                    name.append(chars[j])
                    j += 1
                }
                if !name.isEmpty, matchAt(chars, j, "#&gt;") {
                    out += "<span class=\"placeholder\">\(name)</span>"
                    i = j + 5
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `![alt](url)` → `<em>[alt]</em>` (alt may be empty → '').
    private static func replaceImages(_ s: String) -> String {
        guard s.contains("![") else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "!", i + 1 < chars.count, chars[i + 1] == "[" {
                if let m = matchBracketParen(chars, i + 1, allowEmptyFirst: true) {
                    out += m.first.isEmpty ? "" : "<em>[\(m.first)]</em>"
                    i = m.end
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `[text](url)` → `<a href="…">text</a>` (text ≥1, url ≥1).
    private static func replaceLinks(_ s: String) -> String {
        guard s.contains("[") else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "[" {
                if let m = matchBracketParen(chars, i, allowEmptyFirst: false) {
                    let href = RenderHelpers.isSafeHref(m.second) ? m.second : "#"
                    out += "<a href=\"\(href)\">\(m.first)</a>"
                    i = m.end
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `[]([^)]*)` removal.
    private static func removeEmptyLinks(_ s: String) -> String {
        guard s.contains("[](") else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, "[](") {
                var j = i + 3
                while j < chars.count, chars[j] != ")" { j += 1 }
                if j < chars.count, chars[j] == ")" {
                    i = j + 1
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// `(?<![A-Za-z0-9])_(.+?)_(?![A-Za-z0-9])` → `<em>…</em>`.
    private static func wrapUnderscoreItalic(_ s: String) -> String {
        guard s.contains("_") else { return s }
        let chars = Array(s)
        var out: [Character] = []
        var i = 0
        while i < chars.count {
            if chars[i] == "_" {
                let prevOK = out.last.map { !isAlnum($0) } ?? true
                if prevOK {
                    // find next '_' (≥1 char between, no newline) whose following char is non-alnum.
                    var j = i + 1
                    while j < chars.count, chars[j] != "\n" {
                        if chars[j] == "_", j > i + 1 {
                            let nextOK = (j + 1 >= chars.count) || !isAlnum(chars[j + 1])
                            if nextOK { break }
                        }
                        j += 1
                    }
                    if j < chars.count, chars[j] == "_", j > i + 1,
                        (j + 1 >= chars.count) || !isAlnum(chars[j + 1])
                    {
                        out.append(contentsOf: Array("<em>"))
                        out.append(contentsOf: chars[(i + 1) ..< j])
                        out.append(contentsOf: Array("</em>"))
                        i = j + 1
                        continue
                    }
                }
            }
            out.append(chars[i])
            i += 1
        }
        return String(out)
    }

    // MARK: - generic scanner helpers

    /// Global non-greedy `marker(.+?)marker` → `open + content + close`. `.`
    /// excludes newline, content ≥1 char. Content is NOT re-scanned.
    private static func wrapPairs(_ s: String, _ marker: String, _ open: String, _ close: String) -> String {
        guard s.contains(marker) else { return s }
        let m = Array(marker)
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, m) {
                let contentStart = i + m.count
                var j = contentStart
                var found = -1
                while j < chars.count, chars[j] != "\n" {
                    if matchAt(chars, j, m), j > contentStart {
                        found = j
                        break
                    }
                    j += 1
                }
                if found > contentStart {
                    out += open + String(chars[contentStart ..< found]) + close
                    i = found + m.count
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// Match `[first](second)` starting at `open` (`[`). `allowEmptyFirst` toggles
    /// `[^\]]*` vs `[^\]]+`; second is `[^)]+`. Returns the captures + end index.
    private static func matchBracketParen(_ chars: [Character], _ open: Int, allowEmptyFirst: Bool)
        -> (first: String, second: String, end: Int)?
    {
        guard open < chars.count, chars[open] == "[" else { return nil }
        var j = open + 1
        var first = ""
        while j < chars.count, chars[j] != "]" {
            first.append(chars[j])
            j += 1
        }
        guard j < chars.count, chars[j] == "]" else { return nil }
        if !allowEmptyFirst && first.isEmpty { return nil }
        j += 1
        guard j < chars.count, chars[j] == "(" else { return nil }
        j += 1
        var second = ""
        while j < chars.count, chars[j] != ")" {
            second.append(chars[j])
            j += 1
        }
        guard j < chars.count, chars[j] == ")", !second.isEmpty else { return nil }
        return (first, second, j + 1)
    }

    private static func removeAll(_ s: String, _ needle: String) -> String {
        let nd = Array(needle)
        guard !nd.isEmpty else { return s }
        let chars = Array(s)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, nd) {
                i += nd.count
                continue
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    private static func replaceDoccPlaceholders(_ code: String, _ token: (String) -> String) -> String {
        guard code.contains("<#") else { return code }
        let chars = Array(code)
        var out = ""
        var i = 0
        while i < chars.count {
            if chars[i] == "<", i + 1 < chars.count, chars[i + 1] == "#" {
                var j = i + 2
                var name = ""
                while j < chars.count, chars[j] != "#", chars[j] != ">", chars[j] != "\n" {
                    name.append(chars[j])
                    j += 1
                }
                if !name.isEmpty, matchAt(chars, j, "#>") {
                    out += token(name)
                    i = j + 2
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    private static func restoreDoccPlaceholders(_ block: String, _ placeholders: [String]) -> String {
        guard block.contains("DoccPh") else { return block }
        let chars = Array(block)
        var out = ""
        var i = 0
        while i < chars.count {
            if matchAt(chars, i, "DoccPh") {
                var j = i + 6
                var digits = ""
                while j < chars.count, chars[j] >= "0", chars[j] <= "9" {
                    digits.append(chars[j])
                    j += 1
                }
                if !digits.isEmpty, matchAt(chars, j, "DoccPh"), let idx = Int(digits) {
                    let name = idx < placeholders.count ? placeholders[idx] : ""
                    out += "<span class=\"placeholder\">\(RenderHelpers.escapeHtml(name))</span>"
                    i = j + 6
                    continue
                }
            }
            out.append(chars[i])
            i += 1
        }
        return out
    }

    /// encodeURIComponent: keep `A-Za-z0-9-_.!~*'()`, percent-encode the rest (UTF-8).
    private static func encodeURIComponent(_ s: String) -> String {
        let unreserved = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        let hex = Array("0123456789ABCDEF")
        var out = ""
        for ch in s {
            if unreserved.contains(ch) {
                out.append(ch)
            } else {
                for byte in String(ch).utf8 {
                    out.append("%")
                    out.append(hex[Int(byte >> 4)])
                    out.append(hex[Int(byte & 0x0F)])
                }
            }
        }
        return out
    }

    // MARK: - char helpers

    private static func matchAt(_ chars: [Character], _ i: Int, _ literal: String) -> Bool {
        matchAt(chars, i, Array(literal))
    }
    private static func matchAt(_ chars: [Character], _ i: Int, _ literal: [Character]) -> Bool {
        guard i >= 0, i + literal.count <= chars.count else { return false }
        for k in 0 ..< literal.count where chars[i + k] != literal[k] { return false }
        return true
    }
    private static func isWordChar(_ ch: Character) -> Bool {
        (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch == "_"
    }
    private static func isAlnum(_ ch: Character) -> Bool {
        (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9")
    }
    private static func isJsWhitespace(_ ch: Character) -> Bool { ch.isWhitespace }
}

extension String {
    /// `.replace(/-/g, ' ')`.
    fileprivate func replacingDashes() -> String { String(map { $0 == "-" ? " " : $0 }) }
}
