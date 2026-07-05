// The read_doc / search_docs(read=true) document-shaped pagination —
// a Swift port of the deleted JS `paginateDocumentPayload` + its
// `buildDocumentPagePayload`/`splitOversizedSection` helpers
// (`src/mcp/pagination.js` + `src/mcp/pagination/page-builder.js` at
// `200a744`, before `9078247` deleted `src/mcp/*`). Layers on the generic
// primitives in `Pagination.swift`.
//
// Strategy dispatch (mirrors `paginateDocumentPayload` exactly):
//   1. Does the WHOLE envelope (content kept, sections dropped) already fit
//      in one page? Return it as-is; reject a request for any page but 1.
//   2. Already match-narrowed (`envelope.matches != nil`)? Array-paginate
//      the matches.
//   3. No sections available (`envelope.sections.isEmpty`)? Paginate the
//      raw `content` string as a text window.
//   4. Otherwise: section-bucket bin-packing — each section is a unit,
//      re-rendering Markdown per page; a section too large to fit even
//      alone is split (paragraph → line → character-window) and retried;
//      giving up (a section that cannot be split further, or the retry
//      budget exhausted) falls back to the text-window strategy over the
//      full document.

import ADContent
import ADJSON
import ADStorage

extension Pagination {
    /// The read_doc/search_docs(read=true) envelope AFTER metadata/content/
    /// sections/note are resolved — and, when a `match` was requested, AFTER
    /// the match-excerpt step has already narrowed it (mirrors JS's
    /// `sanitizeDocumentPayload` + optional `buildMatchedDocumentPayload`
    /// result) — but BEFORE pagination. Still holds `sections` as typed rows
    /// (not JSON) so the section-bucket strategy can re-render Markdown for a
    /// subset of them. `found: false` is handled entirely by the caller
    /// (read_doc / search_docs never reach this type in that case — see
    /// `Tools+Lookup.swift`), so there is no `found` field to model here.
    struct DocumentEnvelope: Sendable {
        var metadata: JSONValue
        var content: String?
        var sections: [DocumentSectionRow]
        var note: String?
        var matches: [JSONValue]?
        var bestMatch: JSONValue?
        var renderDocument: DocMarkdownDocument
    }

    /// `paginateDocumentPayload(payload, {maxChars, page, document})` +
    /// `projectReadDoc(payload, {full})`'s key order/shape, fused into one
    /// call: returns the complete `{found:true, ...}` object read_doc /
    /// search_docs(read=true) hand to `.okValue`. `maxChars == nil` skips
    /// pagination entirely (JS: `if (args.maxChars != null) payload =
    /// paginateDocumentPayload(...)` — the whole module is bypassed).
    static func buildDocumentResult(
        _ envelope: DocumentEnvelope, maxChars: Int?, page: Int, full: Bool
    ) throws(Failure) -> JSONValue {
        guard let maxChars else {
            return assembleDocument(envelope, full: full, pageInfo: nil)
        }

        // `sanitizedBase = {...payload, sections: []}`: the "does everything
        // fit on one page" probe (and the page it returns, if so) NEVER
        // carries `sections` — `content` alone represents the full document
        // once pagination is active, so `sections` would double-count it.
        var probeEnvelope = envelope
        probeEnvelope.sections = []
        let singlePage = assembleDocument(
            probeEnvelope, full: full, pageInfo: pageInfoJSON(page: 1, totalPages: 1))
        if serializedLength(singlePage) <= maxChars {
            guard page == 1 else { throw Failure.onlyPageOneAvailable }
            return singlePage
        }

        if envelope.matches != nil {
            return try paginateMatches(envelope, full: full, maxChars: maxChars, page: page)
        }
        if envelope.sections.isEmpty {
            return try paginateTextWindow(envelope, full: full, maxChars: maxChars, page: page)
        }
        return try paginateSectionBucket(envelope, full: full, maxChars: maxChars, page: page)
    }

    /// `projectReadDoc`'s exact output shape/order:
    /// `found, metadata, content, sections, matches?, note?, bestMatch?, pageInfo?`.
    /// Faithfully serializes whatever `envelope` currently holds — callers
    /// (not this function) are responsible for zeroing `sections`/`content`/
    /// `note` per strategy, exactly as each JS branch does before spreading.
    private static func assembleDocument(_ envelope: DocumentEnvelope, full: Bool, pageInfo: JSONValue?)
        -> JSONValue
    {
        var out: OrderedDictionary<String, JSONValue> = ["found": .bool(true), "metadata": envelope.metadata]
        out["content"] = envelope.content.map(JSONValue.string) ?? .null
        out["sections"] = .array(envelope.sections.map(full ? projectSectionFull : sectionSkeleton))
        if let matches = envelope.matches { out["matches"] = .array(matches) }
        if let note = envelope.note { out["note"] = .string(note) }
        if let bestMatch = envelope.bestMatch { out["bestMatch"] = bestMatch }
        if let pageInfo { out["pageInfo"] = pageInfo }
        return .object(out)
    }

    /// `paginateMatchedDocumentPayload`: array-paginates `envelope.matches`
    /// (content forced null, sections empty, note dropped per page — JS's
    /// `{...payload, note: undefined, matches: slice, content: null}`).
    private static func paginateMatches(
        _ envelope: DocumentEnvelope, full: Bool, maxChars: Int, page: Int
    ) throws(Failure) -> JSONValue {
        let matches = envelope.matches ?? []
        return try paginateArray(items: matches, maxChars: maxChars, page: page) {
            slice, pageIndex, totalPages in
            var pageEnvelope = envelope
            pageEnvelope.content = nil
            pageEnvelope.sections = []
            pageEnvelope.matches = Array(slice)
            pageEnvelope.note = nil
            return assembleDocument(
                pageEnvelope, full: full,
                pageInfo: pageInfoJSON(page: pageIndex, totalPages: totalPages, totalItems: matches.count))
        }
    }

    /// `paginateTextWindowPayload`: paginates the raw `content` string
    /// (sections empty, note dropped per page).
    private static func paginateTextWindow(
        _ envelope: DocumentEnvelope, full: Bool, maxChars: Int, page: Int
    ) throws(Failure) -> JSONValue {
        try paginateText(envelope.content ?? "", maxChars: maxChars, page: page) {
            slice, pageIndex, totalPages in
            var pageEnvelope = envelope
            pageEnvelope.content = slice
            pageEnvelope.sections = []
            pageEnvelope.note = nil
            return assembleDocument(
                pageEnvelope, full: full, pageInfo: pageInfoJSON(page: pageIndex, totalPages: totalPages))
        }
    }

    /// Section-bucket bin-packing with oversized-section splitting — mirrors
    /// `paginateDocumentPayload`'s inline loop EXACTLY: one shared budget of
    /// `maxPlanIterations` retries covers BOTH the totalPages fixed-point
    /// convergence AND the split-and-retry path (not a separate budget for
    /// each, matching JS's single `for` loop), because it calls
    /// `buildArrayPages` directly rather than the wrapped `paginateArray`.
    private static func paginateSectionBucket(
        _ envelope: DocumentEnvelope, full: Bool, maxChars: Int, page: Int
    ) throws(Failure) -> JSONValue {
        var units = envelope.sections.map(SectionUnit.init)
        var assumedTotalPages = 1
        var pagePayloads: [JSONValue]?

        func buildPage(_ slice: ArraySlice<SectionUnit>, _ pageIndex: Int, _ totalPages: Int) -> JSONValue {
            var pageEnvelope = envelope
            pageEnvelope.content = renderSectionSlice(
                envelope.renderDocument, Array(slice), firstPage: pageIndex == 1)
            pageEnvelope.sections = []
            pageEnvelope.note = nil
            return assembleDocument(
                pageEnvelope, full: full, pageInfo: pageInfoJSON(page: pageIndex, totalPages: totalPages))
        }

        for _ in 0 ..< maxPlanIterations {
            do {
                let pages = try buildArrayPages(
                    items: units, totalPages: assumedTotalPages, maxChars: maxChars, buildPage: buildPage)
                pagePayloads = pages
                if pages.count == assumedTotalPages { break }
                assumedTotalPages = pages.count
            } catch Failure.itemTooLarge(_, let itemIndex) {
                let oversized = units[itemIndex]
                let targetChars = max(
                    minSectionFragmentChars,
                    min(oversized.contentText.utf16.count / 2, Int(Double(maxChars) * 0.75)))
                let split = splitOversizedSection(oversized, targetChars: targetChars)
                guard split.count > 1 else {
                    return try paginateTextWindow(envelope, full: full, maxChars: maxChars, page: page)
                }
                units.replaceSubrange(itemIndex ..< itemIndex + 1, with: split)
                assumedTotalPages = max(assumedTotalPages, 1)
                pagePayloads = nil
            } catch {
                // `units` is never empty here (guarded by the caller's
                // `sections.isEmpty` dispatch above), so `buildArrayPages`'
                // `.emptyPageTooLarge` branch is unreachable in practice —
                // propagate defensively rather than assume it.
                throw error
            }
        }

        guard let pages = pagePayloads else {
            return try paginateTextWindow(envelope, full: full, maxChars: maxChars, page: page)
        }
        guard page >= 1, page <= pages.count else {
            throw Failure.pageOutOfRange(page: page, totalPages: pages.count)
        }
        return pages[page - 1]
    }

    /// `buildDocumentPagePayload`'s `renderMarkdown(document, pageSections,
    /// {includeFrontMatter, includeTitle})` call — only the FIRST page
    /// repeats the front matter + `# title` heading; later pages are
    /// body-only continuations of the same document.
    private static func renderSectionSlice(
        _ document: DocMarkdownDocument, _ units: [SectionUnit], firstPage: Bool
    ) -> String {
        let sections = units.map {
            DocMarkdownSection(
                kind: $0.sectionKind, heading: $0.heading, contentText: $0.contentText,
                contentJSON: $0.contentJSON, sortOrder: $0.sortOrder)
        }
        return DocMarkdown.render(
            document: document, sections: sections, includeFrontMatter: firstPage, includeTitle: firstPage)
    }
}

// MARK: - Section splitting (page-builder.js: splitOversizedSection + text-utils.js)

/// `MIN_SECTION_FRAGMENT_CHARS` (page-builder.js).
private let minSectionFragmentChars = 160

/// A section-bucket pagination unit. Mirrors `DocumentSectionRow`'s shape,
/// but is constructible in this module (ADStorage's row type has no public
/// memberwise init) and coerces `contentText` to non-optional up front —
/// exactly JS's `units = sections.map(s => ({...s, contentText: s.contentText
/// ?? s.content_text ?? ''}))` — so every downstream helper works with a
/// plain `String`.
private struct SectionUnit {
    var sectionKind: String?
    var heading: String?
    var contentText: String
    var contentJSON: String?
    var sortOrder: Double

    init(_ row: DocumentSectionRow) {
        sectionKind = row.sectionKind
        heading = row.heading
        contentText = row.contentText ?? ""
        contentJSON = row.contentJSON
        sortOrder = row.sortOrder
    }

    init(sectionKind: String?, heading: String?, contentText: String, contentJSON: String?, sortOrder: Double) {
        self.sectionKind = sectionKind
        self.heading = heading
        self.contentText = contentText
        self.contentJSON = contentJSON
        self.sortOrder = sortOrder
    }
}

/// `splitOversizedSection(section, targetChars)`: breaks one section's
/// `contentText` into fragments — paragraph → line → character-window — each
/// sized near `targetChars`. Returns `[section]` UNCHANGED when the text is
/// empty or already at/under `minSectionFragmentChars` (nothing to gain by
/// splitting); the caller's `count <= 1` check is what triggers the
/// text-window fallback for the whole document in that case. Every fragment
/// keeps the parent's `heading`/`sectionKind`/`sortOrder` (JS: `{...section,
/// contentText: piece, contentJson: null}`) — the STABLE section-bucket sort
/// (sortOrder, then original array position) keeps same-`sortOrder`
/// fragments in split order because `units.replaceSubrange` places them
/// contiguously at the original section's array position.
private func splitOversizedSection(_ section: SectionUnit, targetChars: Int) -> [SectionUnit] {
    let text = section.contentText
    guard !text.isEmpty, text.utf16.count > minSectionFragmentChars else { return [section] }
    let effectiveTarget = max(minSectionFragmentChars, min(targetChars, max(text.utf16.count - 1, 1)))

    let pieces = groupChunks(splitText(text), targetChars: effectiveTarget)
    let fragments = pieces.count > 1 ? pieces : splitByCharacterWindow(text, targetChars: effectiveTarget)
    return fragments.map { piece in
        SectionUnit(
            sectionKind: section.sectionKind, heading: section.heading, contentText: piece,
            contentJSON: nil, sortOrder: section.sortOrder)
    }
}

/// `splitText(text)`: paragraphs (2+ consecutive newlines) when there's more
/// than one; else lines (single newlines) when there's more than one; else
/// the whole (trimmed) text as one chunk.
private func splitText(_ text: String) -> [String] {
    let paragraphs = splitOnBlankLines(text).map(trimJS).filter { !$0.isEmpty }
    if paragraphs.count > 1 { return paragraphs }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map { trimJS(String($0)) }
        .filter { !$0.isEmpty }
    if lines.count > 1 { return lines }
    return [trimJS(text)]
}

/// `text.split(/\n{2,}/)`: splits on a RUN of 2-or-more newlines (the whole
/// run is ONE delimiter — a single lone `\n` is kept as content, not a split
/// point).
private func splitOnBlankLines(_ text: String) -> [String] {
    var parts: [String] = []
    var current = ""
    var index = text.startIndex
    while index < text.endIndex {
        if text[index] == "\n" {
            var run = index
            var count = 0
            while run < text.endIndex, text[run] == "\n" {
                count += 1
                run = text.index(after: run)
            }
            if count >= 2 {
                parts.append(current)
                current = ""
                index = run
                continue
            }
        }
        current.append(text[index])
        index = text.index(after: index)
    }
    parts.append(current)
    return parts
}

/// `groupChunks(chunks, targetChars)`: greedily concatenates consecutive
/// chunks (joined by `"\n\n"`) while the running UTF-16 length stays at/under
/// `targetChars`; a chunk that alone exceeds the target still starts (and
/// stays alone in) its own group, matching JS's `buffer.length === 0` escape
/// hatch (a group is never left empty just because the first chunk overflows).
private func groupChunks(_ chunks: [String], targetChars: Int) -> [String] {
    var groups: [String] = []
    var buffer: [String] = []
    var bufferLength = 0

    for chunk in chunks {
        let separator = buffer.isEmpty ? 0 : 2
        if bufferLength + separator + chunk.utf16.count <= targetChars || buffer.isEmpty {
            buffer.append(chunk)
            bufferLength += separator + chunk.utf16.count
            continue
        }
        groups.append(buffer.joined(separator: "\n\n"))
        buffer = [chunk]
        bufferLength = chunk.utf16.count
    }
    if !buffer.isEmpty { groups.append(buffer.joined(separator: "\n\n")) }
    return groups
}

/// `splitByCharacterWindow(text, targetChars)`: the character-window fallback
/// when paragraph/line grouping still yields <= 1 piece (one unbroken block
/// of text) — reuses the SAME UTF-16 boundary-snapping the text paginator
/// uses, just without a serialized-length budget (a flat `targetChars` count
/// instead).
private func splitByCharacterWindow(_ text: String, targetChars: Int) -> [String] {
    let units = Array(text.utf16)
    var parts: [String] = []
    var start = 0
    while start < units.count {
        start = Pagination.skipWhitespace(units, start)
        if start >= units.count { break }
        let end = min(units.count, start + targetChars)
        let slice = Pagination.sliceAtBoundary(units, start: start, end: end)
        if !slice.text.isEmpty { parts.append(slice.text) }
        start = slice.end
    }
    return parts
}

/// `.trim()` — trims the same JS `\s` class `Pagination.trimmedUTF16` uses,
/// operating on a native `String` (no UTF-16 round trip needed here since
/// `splitOnBlankLines`/the line-split above only ever CONCATENATE or COMPARE
/// whole chunks, never slice mid-string). Checks whole `Character`s (grapheme
/// clusters), not raw scalars, so `dropFirst()`/`dropLast()` never split a
/// multi-scalar grapheme — a character only counts as whitespace when it is
/// ITSELF exactly one JS-whitespace scalar.
private func trimJS(_ text: String) -> String {
    var slice = Substring(text)
    while let first = slice.first, isJSWhitespaceCharacter(first) { slice = slice.dropFirst() }
    while let last = slice.last, isJSWhitespaceCharacter(last) { slice = slice.dropLast() }
    return String(slice)
}

private func isJSWhitespaceCharacter(_ character: Character) -> Bool {
    guard character.unicodeScalars.count == 1, let scalar = character.unicodeScalars.first,
        scalar.value <= 0xFFFF
    else { return false }
    return Pagination.isJSWhitespaceCodePoint(UInt16(scalar.value))
}
