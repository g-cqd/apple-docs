// GuidelinesParser — the App Store Review Guidelines HTML parser (port of
// src/apple/guidelines-parser.js + guidelines/{html-to-markdown,section-meta,
// hierarchy}.js). Two passes, like the JS:
//
//   Pass 1 — a targeted scanner (the HTMLRewriter equivalent) records each
//   `h3[data-sidenav]` / `li[data-sidenav]` (id, data-sidenav title, data-nr),
//   injects a `<!--§SPLIT:N-->` marker before it, and removes the
//   ASR/localization `<span class="custom-tooltip-icon|loc-en-only|loc-j|
//   loc-cj">…</span>` subtrees. Matches are gated to AFTER the
//   `id="content-container"` position (the JS uses the ancestor selector;
//   every real match sits inside the container either way).
//
//   Pass 2 — slice from the container, split on markers, convert each chunk
//   with the guidelines-tuned htmlToMarkdown, extract title/number/abstract,
//   assign role/roleHeading by tag, then buildHierarchy over the dotted
//   section numbers.

import Foundation

public enum GuidelinesParser {
    public static let guidelinesURL = "https://developer.apple.com/app-store/review/guidelines/"
    public static let rootSlug = "app-store-review"

    /// One parsed guideline section (the JS section object).
    public struct Section: Sendable, Equatable {
        public var id: String
        public var path: String
        public var title: String
        public var abstract: String
        public var markdown: String
        public var role: String
        public var roleHeading: String
        public var notarization: Bool
        public var sectionNumber: String?
        public var children: [String]
    }

    public struct ParseResult: Sendable, Equatable {
        public var sections: [Section]
        public var lastUpdated: String?
    }

    public enum ParseError: Error, Sendable {
        case missingContentContainer
    }

    // MARK: - entry point

    public static func parse(_ html: String) throws -> ParseResult {
        // ── Pass 1 ───────────────────────────────────────────────────────────
        var meta: [(id: String, sidenavTitle: String?, notarization: Bool, tag: String)] = []
        let transformed = injectMarkersAndStrip(html, meta: &meta)

        guard let containerRange = transformed.range(of: "id=\"content-container\"") else {
            throw ParseError.missingContentContainer
        }
        let contentHtml = String(transformed[containerRange.lowerBound...])

        // ── Pass 2 (all offsets in UNICODE-SCALAR space — markerPositions
        // indexes scalars, so the slices must too) ───────────────────────────
        var sections: [Section] = []
        let contentScalars = Array(contentHtml.unicodeScalars)
        let markers = markerPositions(contentHtml)
        for (index, marker) in markers.enumerated() where marker.metaIndex < meta.count {
            let entry = meta[marker.metaIndex]
            let chunkEnd = index + 1 < markers.count ? markers[index + 1].start : contentScalars.count
            let chunkHtml = String(String.UnicodeScalarView(contentScalars[marker.end ..< chunkEnd]))

            let markdown = htmlToMarkdown(chunkHtml)
            let title = resolveTitle(sidenavTitle: entry.sidenavTitle, id: entry.id, markdown: markdown)
            let sectionNumber = extractSectionNumber(title)
            let path = sectionNumber.map { "\(rootSlug)/\($0)" } ?? "\(rootSlug)/\(entry.id)"
            let abstract = extractAbstract(markdown)
            sections.append(
                Section(
                    id: entry.id, path: path, title: title, abstract: abstract, markdown: markdown,
                    role: entry.tag == "h3" ? "collection" : "article",
                    roleHeading: entry.tag == "h3" ? "Section" : "Guideline",
                    notarization: entry.notarization, sectionNumber: sectionNumber, children: []))
        }

        buildHierarchy(&sections)
        return ParseResult(sections: sections, lastUpdated: extractLastUpdated(contentHtml))
    }

    // MARK: - pass 1: markers + strips

    /// Scan tags; before each `h3`/`li` carrying `data-sidenav` (past the
    /// content-container position) inject `<!--§SPLIT:N-->` and record its
    /// meta; drop `<span class="…">` subtrees for the four stripped classes.
    static func injectMarkersAndStrip(
        _ html: String, meta: inout [(id: String, sidenavTitle: String?, notarization: Bool, tag: String)]
    ) -> String {
        let scalars = Array(html.unicodeScalars)
        let containerAt = indexOf(scalars, needle: "id=\"content-container\"") ?? Int.max
        var out = String.UnicodeScalarView()
        var i = 0
        let n = scalars.count
        let strippedClasses: Set<String> = ["custom-tooltip-icon", "loc-en-only", "loc-j", "loc-cj"]

        while i < n {
            guard scalars[i] == "<", let tag = parseTag(scalars, at: i) else {
                out.append(scalars[i])
                i += 1
                continue
            }

            // Strip the badge/localization spans (subtree removal).
            if !tag.isClosing, tag.name == "span",
                let cls = tag.attributes["class"],
                classList(cls).contains(where: { strippedClasses.contains($0) })
            {
                i = skipSubtree(scalars, from: i, tagEnd: tag.end, name: "span", selfClosing: tag.selfClosing)
                continue
            }

            // Marker injection for data-sidenav h3/li inside the container.
            if !tag.isClosing, tag.name == "h3" || tag.name == "li",
                tag.attributes.keys.contains("data-sidenav"), i >= containerAt
            {
                let sidenav = tag.attributes["data-sidenav"] ?? ""
                meta.append(
                    (
                        id: tag.attributes["id"] ?? "",
                        sidenavTitle: sidenav.isEmpty ? nil : sidenav,
                        notarization: tag.attributes.keys.contains("data-nr"),
                        tag: tag.name
                    ))
                out.append(contentsOf: "<!--§SPLIT:\(meta.count - 1)-->".unicodeScalars)
            }

            // Copy the tag verbatim.
            for k in i ..< tag.end { out.append(scalars[k]) }
            i = tag.end
        }
        return String(out)
    }

    /// Skip an element subtree (`el.remove()`): from the opening tag through
    /// its matching close, honoring nesting of the same tag name.
    static func skipSubtree(
        _ scalars: [Unicode.Scalar], from start: Int, tagEnd: Int, name: String, selfClosing: Bool
    ) -> Int {
        if selfClosing { return tagEnd }
        var depth = 1
        var i = tagEnd
        while i < scalars.count {
            guard scalars[i] == "<", let tag = parseTag(scalars, at: i) else {
                i += 1
                continue
            }
            if tag.name == name {
                if tag.isClosing {
                    depth -= 1
                    if depth == 0 { return tag.end }
                } else if !tag.selfClosing {
                    depth += 1
                }
            }
            i = tag.end
        }
        return scalars.count
    }

    struct MarkerPosition {
        let start: Int
        let end: Int
        let metaIndex: Int
    }

    /// `/<!--§SPLIT:(\d+)-->/g` over the (scalar-indexed) content.
    static func markerPositions(_ content: String) -> [MarkerPosition] {
        let scalars = Array(content.unicodeScalars)
        let prefix = Array("<!--§SPLIT:".unicodeScalars)
        var out: [MarkerPosition] = []
        var i = 0
        while i + prefix.count < scalars.count {
            var match = true
            for (k, c) in prefix.enumerated() where scalars[i + k] != c {
                match = false
                break
            }
            if match {
                var j = i + prefix.count
                var digits = ""
                while j < scalars.count, scalars[j].value >= 48, scalars[j].value <= 57 {
                    digits.unicodeScalars.append(scalars[j])
                    j += 1
                }
                if !digits.isEmpty, j + 2 < scalars.count, scalars[j] == "-", scalars[j + 1] == "-",
                    scalars[j + 2] == ">"
                {
                    out.append(MarkerPosition(start: i, end: j + 3, metaIndex: Int(digits) ?? 0))
                    i = j + 3
                    continue
                }
            }
            i += 1
        }
        return out
    }

    // MARK: - htmlToMarkdown (guidelines flavor)

    /// Port of guidelines/html-to-markdown.js: an event-driven walk emitting
    /// markdown parts, then the JS cleanup regex chain.
    static func htmlToMarkdown(_ html: String) -> String {
        let scalars = Array(html.unicodeScalars)
        var parts: [String] = []
        var skipDepth = 0
        /// Stack of (tagName, role) for close-tag bookkeeping of the handlers
        /// that emit on end (headings, p, strong, em, a, code, ul/ol, li) and
        /// the skip containers.
        var stack: [(name: String, role: CloseAction)] = []
        var listStack: [String] = []
        var inStrong = false
        var strongBuf = ""
        var linkHref: String? = nil

        func emit(_ s: String) {
            if inStrong { strongBuf += s } else { parts.append(s) }
        }

        var i = 0
        let n = scalars.count
        while i < n {
            guard scalars[i] == "<", let tag = parseTag(scalars, at: i) else {
                // Text node scalar.
                if skipDepth == 0 {
                    var text = String.UnicodeScalarView()
                    while i < n, scalars[i] != "<" {
                        text.append(scalars[i])
                        i += 1
                    }
                    let chunk = String(text)
                    if !chunk.isEmpty { emit(chunk) }
                } else {
                    while i < n, scalars[i] != "<" { i += 1 }
                }
                continue
            }
            i = tag.end

            if tag.isClosing {
                // Pop to the matching open (well-formed input assumption).
                while let top = stack.last {
                    stack.removeLast()
                    runClose(top.role)
                    if top.name == tag.name { break }
                }
                continue
            }

            let cls = tag.attributes["class"] ?? ""
            let classes = classList(cls)
            let id = tag.attributes["id"]

            // Skip containers.
            if classes.contains("sidenav-container") || classes.contains("sticky-container")
                || classes.contains("form-checkbox") || id == "documentation"
            {
                skipDepth += 1
                if !tag.selfClosing && !isVoid(tag.name) {
                    stack.append((tag.name, .endSkip))
                } else {
                    skipDepth -= 1
                }
                continue
            }

            if skipDepth > 0 {
                if !tag.selfClosing && !isVoid(tag.name) { stack.append((tag.name, .none)) }
                continue
            }

            switch tag.name {
                case "h1", "h2", "h3":
                    let level = Int(String(tag.name.dropFirst())) ?? 1
                    parts.append("\n\(String(repeating: "#", count: level)) ")
                    stack.append((tag.name, .emit("\n\n")))
                case "p":
                    stack.append((tag.name, .emit("\n\n")))
                case "strong":
                    inStrong = true
                    strongBuf = ""
                    stack.append((tag.name, .endStrong))
                case "em":
                    emit("*")
                    stack.append((tag.name, .emit("*")))
                case "a" where tag.attributes.keys.contains("href"):
                    linkHref = tag.attributes["href"]
                    emit("[")
                    stack.append((tag.name, .endLink))
                case "code":
                    emit("`")
                    stack.append((tag.name, .emit("`")))
                case "ul":
                    listStack.append(cls.contains("disc") ? "disc" : "no-bullet")
                    stack.append((tag.name, .endList))
                case "ol":
                    listStack.append("ordered")
                    stack.append((tag.name, .endList))
                case "li":
                    let depth = max(0, listStack.count - 1)
                    let indent = String(repeating: "  ", count: depth)
                    switch listStack.last {
                        case "disc": parts.append("\(indent)- ")
                        case "ordered": parts.append("\(indent)1. ")
                        default: break  // no-bullet
                    }
                    stack.append((tag.name, .emit("\n")))
                case "br":
                    parts.append("\n")
                default:
                    if !tag.selfClosing && !isVoid(tag.name) { stack.append((tag.name, .none)) }
            }
            continue
        }

        // The JS cleanup chain (entities decoded AFTER join; &amp; LAST).
        var md = parts.joined()
        md = md.replacingOccurrences(of: "&nbsp;", with: " ")
        md = md.replacingOccurrences(of: "&lt;", with: "<")
        md = md.replacingOccurrences(of: "&gt;", with: ">")
        md = md.replacingOccurrences(of: "&quot;", with: "\"")
        md = md.replacingOccurrences(of: "&#39;", with: "'")
        md = md.replacingOccurrences(of: "&amp;", with: "&")
        md = md.replacingOccurrences(of: "\u{00a0}", with: " ")
        md = md.replacingOccurrences(of: "\t", with: " ")
        md = stripLeadingLineWhitespace(md)  // /^[ \t]+/gm → ''
        md = collapseSpaces(md)  // / {2,}/g → ' '
        md = collapseBlankLines(md)  // /\n{3,}/g → '\n\n'
        return md.trimmingCharacters(in: .whitespacesAndNewlines)

        // The close-action runner uses these captured vars.
        func runClose(_ action: CloseAction) {
            switch action {
                case .none: break
                case .emit(let text):
                    emit(text)
                case .endStrong:
                    inStrong = false
                    parts.append("**\(strongBuf)**")
                    strongBuf = ""
                case .endLink:
                    var href = linkHref
                    if let h = href, h.hasPrefix("/") { href = "https://developer.apple.com\(h)" }
                    emit("](\(href ?? "null"))")
                    linkHref = nil
                case .endList:
                    _ = listStack.popLast()
                    parts.append("\n")
                case .endSkip:
                    skipDepth -= 1
            }
        }
    }

    enum CloseAction {
        case none
        case emit(String)
        case endStrong
        case endLink
        case endList
        case endSkip
    }

    // MARK: - section-meta ports

    /// `resolveTitle(meta, markdown)`.
    static func resolveTitle(sidenavTitle: String?, id: String, markdown: String) -> String {
        if let sidenavTitle, !sidenavTitle.isEmpty {
            return sidenavTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if let firstLine = markdown.split(separator: "\n", omittingEmptySubsequences: false)
            .first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty })
        {
            // `/^#+\s*/` strip.
            var line = String(firstLine)
            var idx = line.startIndex
            while idx < line.endIndex, line[idx] == "#" { idx = line.index(after: idx) }
            if idx > line.startIndex {
                line = String(line[idx...])
                while let f = line.unicodeScalars.first, isJsSpace(f) { line.removeFirst() }
            }
            return line.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        // Fallback: id → words, each word's first char uppercased (`/\b\w/g`).
        let spaced = id.replacingOccurrences(of: "-", with: " ")
        var out = ""
        var atWordStart = true
        for ch in spaced {
            if atWordStart, ch.isLetter || ch.isNumber {
                out.append(Character(String(ch).uppercased()))
                atWordStart = false
            } else {
                out.append(ch)
                if !(ch.isLetter || ch.isNumber || ch == "_") { atWordStart = true }
            }
        }
        return out
    }

    /// `extractSectionNumber(title)` — `/^(\d+(?:\.\d+)*(?:\([a-z]\))?)[\s.]/`,
    /// else `/^(\d+)\.?\s/`.
    static func extractSectionNumber(_ title: String) -> String? {
        let scalars = Array(title.unicodeScalars)
        var i = 0
        func digits() -> Bool {
            let start = i
            while i < scalars.count, isDigit(scalars[i]) { i += 1 }
            return i > start
        }
        guard digits() else { return nil }
        // (\.\d+)*
        while i < scalars.count, scalars[i] == "." {
            let save = i
            i += 1
            if !digits() {
                i = save
                break
            }
        }
        // (\([a-z]\))?
        if i + 2 < scalars.count, scalars[i] == "(", isLowerAlpha(scalars[i + 1]), scalars[i + 2] == ")" {
            i += 3
        }
        // Terminator [\s.]
        if i < scalars.count, isJsSpace(scalars[i]) || scalars[i] == "." {
            return String(String.UnicodeScalarView(scalars[0 ..< i]))
        }
        // Fallback `/^(\d+)\.?\s/`.
        var j = 0
        while j < scalars.count, isDigit(scalars[j]) { j += 1 }
        guard j > 0 else { return nil }
        var k = j
        if k < scalars.count, scalars[k] == "." { k += 1 }
        if k < scalars.count, isJsSpace(scalars[k]) {
            return String(String.UnicodeScalarView(scalars[0 ..< j]))
        }
        return nil
    }

    /// `extractAbstract(markdown)` — strip headings/list prefixes, unwrap
    /// links/bold, first sentence, 300-unit cap.
    static func extractAbstract(_ markdown: String) -> String {
        let lines = markdown.split(separator: "\n", omittingEmptySubsequences: false)
            .filter { !$0.hasPrefix("#") && !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { line -> String in
                var s = String(line)
                // `/^[-*]\s+/` strip.
                if let first = s.unicodeScalars.first, first == "-" || first == "*" {
                    let after = s.index(after: s.startIndex)
                    if after < s.endIndex, let scalar = s[after...].unicodeScalars.first, isJsSpace(scalar) {
                        s = String(s[after...])
                        while let f = s.unicodeScalars.first, isJsSpace(f) { s.removeFirst() }
                    }
                }
                return s.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        var text = lines.joined(separator: " ")
        text = text.replacingOccurrences(of: "**", with: "")
        text = unwrapLinks(text)
        text = collapseJsWhitespaceRuns(text)
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        // `/^(.+?[.!?])\s/` — the shortest prefix ending a sentence, then a space.
        if let sentence = firstSentence(text) { return String(sentence.prefix(300)) }
        return String(text.prefix(300))
    }

    /// `extractLastUpdated(html)` — `/Last Updated:\s*<a[^>]*>([^<]+)<\/a>/`.
    static func extractLastUpdated(_ html: String) -> String? {
        let scalars = Array(html.unicodeScalars)
        let needle = Array("Last Updated:".unicodeScalars)
        var i = 0
        outer: while i + needle.count <= scalars.count {
            for (k, c) in needle.enumerated() where scalars[i + k] != c {
                i += 1
                continue outer
            }
            var j = i + needle.count
            while j < scalars.count, isJsSpace(scalars[j]) { j += 1 }
            guard j + 1 < scalars.count, scalars[j] == "<",
                scalars[j + 1] == "a" || scalars[j + 1] == "A"
            else {
                i += 1
                continue
            }
            var k = j
            while k < scalars.count, scalars[k] != ">" { k += 1 }
            guard k < scalars.count else { return nil }
            k += 1
            var text = String.UnicodeScalarView()
            while k < scalars.count, scalars[k] != "<" {
                text.append(scalars[k])
                k += 1
            }
            let value = String(text).trimmingCharacters(in: .whitespacesAndNewlines)
            return value.isEmpty ? nil : value
        }
        return nil
    }

    // MARK: - hierarchy port

    /// `buildHierarchy(sections)` — dotted-number parent links.
    static func buildHierarchy(_ sections: inout [Section]) {
        var indexByNumber: [String: Int] = [:]
        for (i, section) in sections.enumerated() {
            if let number = section.sectionNumber, indexByNumber[number] == nil {
                indexByNumber[number] = i
            }
        }
        for section in sections {
            guard let number = section.sectionNumber, let parent = parentNumber(number),
                let parentIndex = indexByNumber[parent]
            else { continue }
            sections[parentIndex].children.append(section.path)
        }
    }

    /// `findParentNumber` — `3.1.3(a)` → `3.1.3`; `1.1.1` → `1.1`; `1` → nil.
    static func parentNumber(_ number: String) -> String? {
        if number.contains("(") {
            // `/\([a-z]\)$/` strip.
            let scalars = Array(number.unicodeScalars)
            if scalars.count >= 3, scalars[scalars.count - 3] == "(",
                isLowerAlpha(scalars[scalars.count - 2]), scalars[scalars.count - 1] == ")"
            {
                return String(String.UnicodeScalarView(scalars[0 ..< (scalars.count - 3)]))
            }
            return number
        }
        guard let lastDot = number.lastIndex(of: ".") else { return nil }
        return String(number[..<lastDot])
    }

    // MARK: - tag tokenizer

    struct Tag {
        let name: String
        let isClosing: Bool
        let selfClosing: Bool
        let attributes: [String: String]
        /// Scalar index just past the closing `>`.
        let end: Int
    }

    /// Parse `<tag attr="v" …>` / `</tag>` / `<!--…-->` at `i` (which holds
    /// `<`). Comments return a synthetic `!--` tag spanning to `-->`.
    static func parseTag(_ scalars: [Unicode.Scalar], at i: Int) -> Tag? {
        var j = i + 1
        guard j < scalars.count else { return nil }
        // Comment: skip to `-->` (treated as an opaque token).
        if j + 2 < scalars.count, scalars[j] == "!", scalars[j + 1] == "-", scalars[j + 2] == "-" {
            var k = j + 3
            while k + 2 < scalars.count {
                if scalars[k] == "-" && scalars[k + 1] == "-" && scalars[k + 2] == ">" {
                    return Tag(name: "!--", isClosing: false, selfClosing: true, attributes: [:], end: k + 3)
                }
                k += 1
            }
            return Tag(name: "!--", isClosing: false, selfClosing: true, attributes: [:], end: scalars.count)
        }
        var closing = false
        if scalars[j] == "/" {
            closing = true
            j += 1
        }
        var name = ""
        while j < scalars.count, isTagNameScalar(scalars[j]) {
            name.unicodeScalars.append(lowerScalar(scalars[j]))
            j += 1
        }
        guard !name.isEmpty else { return nil }

        var attributes: [String: String] = [:]
        var selfClosing = false
        while j < scalars.count, scalars[j] != ">" {
            if scalars[j] == "/" && j + 1 < scalars.count && scalars[j + 1] == ">" {
                selfClosing = true
                j += 1
                break
            }
            if isJsSpace(scalars[j]) {
                j += 1
                continue
            }
            // Attribute name.
            var attrName = ""
            while j < scalars.count, isAttrNameScalar(scalars[j]) {
                attrName.unicodeScalars.append(lowerScalar(scalars[j]))
                j += 1
            }
            guard !attrName.isEmpty else {
                j += 1
                continue
            }
            while j < scalars.count, isJsSpace(scalars[j]) { j += 1 }
            var value = ""
            if j < scalars.count, scalars[j] == "=" {
                j += 1
                while j < scalars.count, isJsSpace(scalars[j]) { j += 1 }
                if j < scalars.count, scalars[j] == "\"" || scalars[j] == "'" {
                    let quote = scalars[j]
                    j += 1
                    while j < scalars.count, scalars[j] != quote {
                        value.unicodeScalars.append(scalars[j])
                        j += 1
                    }
                    if j < scalars.count { j += 1 }
                } else {
                    while j < scalars.count, !isJsSpace(scalars[j]), scalars[j] != ">" {
                        value.unicodeScalars.append(scalars[j])
                        j += 1
                    }
                }
            }
            attributes[attrName] = value
        }
        guard j < scalars.count, scalars[j] == ">" else { return nil }
        return Tag(name: name, isClosing: closing, selfClosing: selfClosing, attributes: attributes, end: j + 1)
    }

    // MARK: - small string helpers

    static func classList(_ cls: String) -> [String] {
        cls.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" }).map(String.init)
    }

    static func isVoid(_ name: String) -> Bool {
        name == "br" || name == "img" || name == "hr" || name == "meta" || name == "link"
            || name == "input"
    }

    static func indexOf(_ scalars: [Unicode.Scalar], needle: String) -> Int? {
        let target = Array(needle.unicodeScalars)
        guard !target.isEmpty, scalars.count >= target.count else { return nil }
        outer: for i in 0 ... (scalars.count - target.count) {
            for (k, c) in target.enumerated() where scalars[i + k] != c { continue outer }
            return i
        }
        return nil
    }

    /// `/^[ \t]+/gm` → ''.
    static func stripLeadingLineWhitespace(_ s: String) -> String {
        s.split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> Substring in
                var l = line
                while let f = l.first, f == " " || f == "\t" { l = l.dropFirst() }
                return l
            }
            .joined(separator: "\n")
    }

    /// `/ {2,}/g` → ' ' (SPACES only, unlike the generic \s collapse).
    static func collapseSpaces(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var spaceRun = 0
        for scalar in s.unicodeScalars {
            if scalar == " " {
                spaceRun += 1
                continue
            }
            if spaceRun > 0 {
                out.append(contentsOf: String(repeating: " ", count: spaceRun > 1 ? 1 : spaceRun).unicodeScalars)
                spaceRun = 0
            }
            out.append(scalar)
        }
        if spaceRun > 0 { out.append(" ") }
        return String(out)
    }

    /// `/\n{3,}/g` → '\n\n'.
    static func collapseBlankLines(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var newlineRun = 0
        for scalar in s.unicodeScalars {
            if scalar == "\n" {
                newlineRun += 1
                continue
            }
            if newlineRun > 0 {
                out.append(contentsOf: String(repeating: "\n", count: min(newlineRun, 2)).unicodeScalars)
                newlineRun = 0
            }
            out.append(scalar)
        }
        if newlineRun > 0 {
            out.append(contentsOf: String(repeating: "\n", count: min(newlineRun, 2)).unicodeScalars)
        }
        return String(out)
    }

    /// `/\[([^\]]+)\]\([^)]+\)/g` → '$1'.
    static func unwrapLinks(_ s: String) -> String {
        let scalars = Array(s.unicodeScalars)
        var out = String.UnicodeScalarView()
        var i = 0
        while i < scalars.count {
            if scalars[i] == "[" {
                // Find `]` with non-empty label, then `(...)`.
                var j = i + 1
                var label = String.UnicodeScalarView()
                while j < scalars.count, scalars[j] != "]" {
                    label.append(scalars[j])
                    j += 1
                }
                if j < scalars.count, !String(label).isEmpty, j + 1 < scalars.count, scalars[j + 1] == "(" {
                    var k = j + 2
                    var hasUrl = false
                    while k < scalars.count, scalars[k] != ")" {
                        hasUrl = true
                        k += 1
                    }
                    if k < scalars.count, hasUrl {
                        out.append(contentsOf: label)
                        i = k + 1
                        continue
                    }
                }
            }
            out.append(scalars[i])
            i += 1
        }
        return String(out)
    }

    /// `/\s+/g` → ' ' (the abstract's whitespace collapse).
    static func collapseJsWhitespaceRuns(_ s: String) -> String {
        var out = String.UnicodeScalarView()
        var inRun = false
        for scalar in s.unicodeScalars {
            if isJsSpace(scalar) {
                if !inRun {
                    out.append(" ")
                    inRun = true
                }
            } else {
                out.append(scalar)
                inRun = false
            }
        }
        return String(out)
    }

    /// `/^(.+?[.!?])\s/` — lazy: the FIRST `[.!?]` followed by whitespace.
    static func firstSentence(_ s: String) -> String? {
        let scalars = Array(s.unicodeScalars)
        guard !scalars.isEmpty else { return nil }
        for i in 0 ..< (scalars.count - 1) {
            let c = scalars[i]
            if c == "." || c == "!" || c == "?", isJsSpace(scalars[i + 1]), i >= 0 {
                // `.+?` needs at least one char before the terminator ⇒ i >= 1
                // is implied when the terminator is at 0? JS `.+?[.!?]` requires
                // ≥1 char BEFORE the punctuation only if the punctuation itself
                // isn't matched by `.+?`… `.` matches any char, so a leading
                // "." could satisfy `.+?` with the NEXT terminator. Minimal
                // correct port: require i >= 1.
                if i >= 1 { return String(String.UnicodeScalarView(scalars[0 ... i])) }
            }
        }
        return nil
    }

    // MARK: - scalar classes

    static func isJsSpace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029,
                0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            default: return false
        }
    }
    static func isDigit(_ s: Unicode.Scalar) -> Bool { s.value >= 48 && s.value <= 57 }
    static func isLowerAlpha(_ s: Unicode.Scalar) -> Bool { s.value >= 97 && s.value <= 122 }
    static func isTagNameScalar(_ s: Unicode.Scalar) -> Bool {
        (s.value >= 65 && s.value <= 90) || (s.value >= 97 && s.value <= 122)
            || (s.value >= 48 && s.value <= 57)
    }
    static func isAttrNameScalar(_ s: Unicode.Scalar) -> Bool {
        isTagNameScalar(s) || s == "-" || s == "_" || s == ":"
    }
    static func lowerScalar(_ s: Unicode.Scalar) -> Unicode.Scalar {
        (s.value >= 65 && s.value <= 90) ? Unicode.Scalar(s.value + 32)! : s
    }
}
