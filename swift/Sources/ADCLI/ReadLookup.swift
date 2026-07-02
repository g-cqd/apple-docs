// The `read` verb's orchestration — a byte-faithful port of cli.js's
// `lookup()` + `paginateCliContent()` + `projectReadDoc({full:true})`, over the
// single-DB corpus snapshot (no on-disk markdown/raw-json, so the cascade
// reduces to the section-render path ad-server's read_doc already proved at
// parity). Two JS quirks are reproduced exactly:
//
//   1. RESOLUTION-PATH METADATA SHAPE. cli.js's `lookup` builds metadata from
//      whatever object the resolver returned. `db.getPage(path)` ALIASES the
//      raw columns (abstract_text→abstract, declaration_text→declaration,
//      platforms_json→platforms), so a PATH lookup surfaces those fields. But
//      `db.searchByTitle(symbol)` runs `SELECT d.*`, returning the RAW column
//      names — so `page.abstract` / `page.declaration` / `page.platforms` are
//      `undefined` for a SYMBOL lookup, and the projection drops abstract +
//      declaration and coalesces platforms to `[]`. We mirror that split via
//      `LookupResolution`.
//   2. UTF-16 PAGINATION. JS `String.length` / `slice` / `lastIndexOf` operate
//      on UTF-16 code units; we paginate over `Array(text.utf16)` and rebuild
//      pages with `String(decoding:as:UTF16.self)` so a byte never drifts.

import ADContent
import ADJSONCore
import ADStorage
import ADWrite
import Foundation

/// The resolved `lookup` opts (path XOR symbol, plus the optional disambiguators).
struct LookupOptions {
    let path: String?
    let symbol: String?
    let framework: String?
    let section: String?
}

/// How the page was resolved — selects the JS metadata-field quirk. `.path`
/// (db.getPage: aliased columns) surfaces abstract/declaration/platforms; `.symbol`
/// (db.searchByTitle: `SELECT d.*`) drops abstract+declaration and forces platforms `[]`.
enum LookupResolution {
    case path
    case symbol
}

/// CLI-only pagination state (mirrors JS `pageInfo`). `totalPages`/etc. feed both
/// the human page footer and the JSON `pageInfo` (which drops `strategy`).
struct LookupPageInfo {
    let page: Int
    let totalPages: Int
    let hasNextPage: Bool
    let hasPreviousPage: Bool
    let strategy: String
}

/// The `lookup` result envelope (mirrors the JS object the formatter + projector
/// consume). `metadata` is nil only for the not-found case; `pageInfo` is set only
/// after pagination actually splits the content.
struct LookupResult {
    var found: Bool
    /// The not-found target (JS `result.path`) — human "Not found: <path>".
    var notFoundTarget: String?
    var metadata: LookupMetadata?
    var content: String?
    /// The sections RETURNED in the envelope (empty unless `--section` widened it).
    var sections: [DocumentSectionRow]
    var note: String?
    var pageInfo: LookupPageInfo?
}

/// The typed metadata the human formatter reads + the JSON projector serializes.
/// `abstractPresent`/`declarationPresent` encode the JS "key exists" distinction:
/// a PATH lookup keeps them (value may be nil → JSON `null`); a SYMBOL lookup
/// drops them entirely (the raw-column-name quirk). `platforms` is the parsed
/// `platforms_json` value for `--json`; the human formatter only emits a Platforms
/// line when it is a non-empty ARRAY (a JS object has no `.length`).
struct LookupMetadata {
    let title: String?
    /// COALESCE(display_name, framework) — the display name (JS `page.framework`).
    let framework: String?
    let rootSlug: String?
    let roleHeading: String?
    let kind: String?
    let abstract: String?
    let abstractPresent: Bool
    let declaration: String?
    let declarationPresent: Bool
    let path: String
    /// Parsed `platforms_json` (object/array), or `[]` (symbol path / null column).
    let platforms: JSONValue
    /// camelCase relation_type → count, in GROUP BY row order. Empty ⇒ key dropped.
    let relationships: [(String, Int64)]
    let isDeprecated: Bool
    let isBeta: Bool
}

// MARK: - lookup

/// Port of cli.js `lookup(opts, ctx)` over the corpus. Resolves the page, then
/// walks the JS content cascade: the PERSISTED sync-time render
/// (`<dataDir>/markdown/<keyPath>.md`, fallback=false → NO note) first, else an
/// on-demand Markdown render from the DB sections (fallback=true → the
/// on-demand note). Assembles metadata + relationship counts, then applies the
/// `--section` extraction. Returns the rich envelope the formatter / projector
/// shape.
///
/// Not ported (unreached on the tested corpora, tracked under WS-E's P4 re-port):
/// `ensureNormalizedDocument` (hydrating sections from the raw payload when the
/// DB has none), the raw-json → normalize → render fallback, and the
/// `cacheOnRead` markdown write-back (the native read verbs never write).
func lookup(_ opts: LookupOptions, _ connection: StorageConnection, dataDir: String) -> LookupResult {
    // Resolve: opts.path (with a normalize-identifier retry), else opts.symbol.
    var record: DocumentRecord?
    var resolution: LookupResolution = .path
    if let path = opts.path {
        resolution = .path
        record = connection.readDocument(path)
        if record == nil, let normalized = normalizeIdentifier(path), normalized != path {
            record = connection.readDocument(normalized)
        }
    } else if let symbol = opts.symbol {
        resolution = .symbol
        record = connection.searchByTitle(symbol, framework: opts.framework)
    }

    guard let page = record else {
        // JS: `{ found: false, path: opts.path ?? opts.symbol }`. The projection
        // drops the path (→ `{found:false}`); the human formatter prints it.
        return LookupResult(
            found: false, notFoundTarget: opts.path ?? opts.symbol, metadata: nil, content: nil,
            sections: [], note: nil, pageInfo: nil)
    }

    let pagePath = page.path

    // Content cascade step 1: the persisted markdown file (JS `readText(mdPath)`).
    // An empty file is falsy in JS (`if (!content)`) ⇒ treated as absent.
    var content = readMarkdownFile(dataDir: dataDir, key: pagePath)
    var fallback = false

    // JS: sections are loaded only when `--section` widened the request (content
    // present), or to back the on-demand render (content absent).
    var sections: [DocumentSectionRow] = []
    if opts.section != nil && content != nil {
        sections = connection.documentSections(pagePath)
    }
    if content == nil {
        sections = connection.documentSections(pagePath)
        if !sections.isEmpty {
            content = renderDocMarkdown(page, sections)
            fallback = true
        }
    }

    let metadata = buildMetadata(page, pagePath: pagePath, resolution: resolution, connection: connection)

    // Section extraction (JS: `opts.section && sections.length > 0`).
    if let sectionQuery = opts.section, !sections.isEmpty {
        if let match = findSection(sections, query: sectionQuery) {
            return LookupResult(
                found: true, notFoundTarget: nil, metadata: metadata,
                content: match.contentText ?? "Section content not available.",
                sections: [match], note: nil, pageInfo: nil)
        }
        let available =
            sections
            .compactMap { $0.heading ?? $0.sectionKind }
            .joined(separator: ", ")
        return LookupResult(
            found: true, notFoundTarget: nil, metadata: metadata, content: nil, sections: sections,
            note: "Section not found: \(sectionQuery). Available sections: \(available)", pageInfo: nil)
    }

    // Note: persisted content ⇒ NO note (JS `fallback ? '…' : undefined`);
    // on-demand render ⇒ the fallback note; no content ⇒ the tier note
    // (lite-tier hint, else the sync hint).
    let note: String?
    if content != nil {
        note = fallback ? "Rendered on-demand from normalized content." : nil
    } else if connection.snapshotTier() == "lite" {
        note = "Content body unavailable on a legacy lite-tier snapshot. Metadata and declaration shown."
    } else {
        note = "No content available. Run apple-docs sync first."
    }

    // JS `sections: includeSections ? sections : []` — a plain read returns []
    // (only `--section` widens it, and that path returned above).
    return LookupResult(
        found: true, notFoundTarget: nil, metadata: metadata, content: content, sections: [], note: note,
        pageInfo: nil)
}

/// The persisted sync-time render: `readText(keyPath(dataDir, 'markdown', key,
/// '.md'))`. nil when the key fails validation (unreachable — the key came from
/// the DB), the file is missing/unreadable, or it is empty (JS falsy).
private func readMarkdownFile(dataDir: String, key: String) -> String? {
    guard let path = Snapshot.storageKeyPath(dataDir: dataDir, subdir: "markdown", key: key, ext: ".md"),
        let text = try? String(contentsOfFile: path, encoding: .utf8),
        !text.isEmpty
    else { return nil }
    return text
}

/// Build the typed metadata, honouring the JS resolution-path quirk (see
/// `LookupMetadata`). PATH keeps abstract/declaration (present, value may be nil)
/// and uses the parsed platforms; SYMBOL drops abstract/declaration and forces
/// platforms `[]`.
private func buildMetadata(
    _ page: DocumentRecord, pagePath: String, resolution: LookupResolution, connection: StorageConnection
) -> LookupMetadata {
    let relationships = relationshipPairs(connection.relationshipCountsByType(pagePath))
    switch resolution {
    case .path:
        return LookupMetadata(
            title: page.title, framework: page.frameworkDisplay, rootSlug: page.rootSlug,
            roleHeading: page.roleHeading, kind: page.kind,
            abstract: page.abstract, abstractPresent: true,
            declaration: page.declaration, declarationPresent: true,
            path: pagePath, platforms: parsePlatforms(page.platformsJSON), relationships: relationships,
            isDeprecated: page.isDeprecated, isBeta: page.isBeta)
    case .symbol:
        // JS reads `page.abstract`/`page.declaration` off a `SELECT d.*` row whose
        // columns are abstract_text/declaration_text — so both are undefined
        // (dropped), and `page.platforms` is undefined → `[]`.
        return LookupMetadata(
            title: page.title, framework: page.frameworkDisplay, rootSlug: page.rootSlug,
            roleHeading: page.roleHeading, kind: page.kind,
            abstract: nil, abstractPresent: false,
            declaration: nil, declarationPresent: false,
            path: pagePath, platforms: .array([]), relationships: relationships,
            isDeprecated: page.isDeprecated, isBeta: page.isBeta)
    }
}

/// `renderMarkdown({ ...page, key: pagePath }, sections)` over the in-process
/// document + section rows — the exact call ad-server read_doc makes, so the
/// rendered bytes never diverge. Maps `DocumentRecord` → coerceDocument's shape
/// and `DocumentSectionRow` → coerceSection (contentText "" when null).
func renderDocMarkdown(_ page: DocumentRecord, _ sections: [DocumentSectionRow]) -> String {
    let document = DocMarkdownDocument(
        key: page.path, title: page.title, framework: page.framework,
        frameworkDisplay: page.frameworkDisplay, role: page.role, roleHeading: page.roleHeading,
        platformsJSON: page.platformsJSON)
    let mapped = sections.map { section in
        DocMarkdownSection(
            kind: section.sectionKind, heading: section.heading,
            contentText: section.contentText ?? "", contentJSON: section.contentJSON,
            sortOrder: section.sortOrder)
    }
    return DocMarkdown.render(document: document, sections: mapped)
}

/// JS `getRelationshipCountsByType` → `[(camelCase, count)]` in GROUP BY row
/// order; unmapped relation types are dropped (and only count > 0 rows survive,
/// already filtered by the storage query).
private func relationshipPairs(_ counts: [RelationshipCount]) -> [(String, Int64)] {
    var out: [(String, Int64)] = []
    for entry in counts {
        guard let camel = relationTypeToCamel(entry.relationType) else { continue }
        out.append((camel, Int64(entry.count)))
    }
    return out
}

/// RELATION_TYPE_TO_CAMEL (documents.js): DB relation_type → camelCase public
/// name. Anything unlisted is dropped so a future relation_type never leaks.
private func relationTypeToCamel(_ relationType: String) -> String? {
    switch relationType {
    case "inherits_from": return "inheritsFrom"
    case "inherited_by": return "inheritedBy"
    case "conforms_to": return "conformsTo"
    case "see-also", "see_also", "seeAlso": return "seeAlso"
    case "child": return "children"
    default: return nil
    }
}

/// `page.platforms ? JSON.parse(page.platforms) : []` — the parsed JSON value
/// (object OR array) for a non-empty `platforms_json`, else `[]`.
private func parsePlatforms(_ json: String?) -> JSONValue {
    guard let json, !json.isEmpty, let value = parseJSONValue(json) else { return .array([]) }
    return value
}

/// lookup's section matcher: heading exact / heading suffix / sectionKind exact,
/// then a contentText substring fallback.
private func findSection(_ sections: [DocumentSectionRow], query: String) -> DocumentSectionRow? {
    if let match = sections.first(where: {
        $0.heading == query || ($0.heading?.hasSuffix(query) ?? false) || $0.sectionKind == query
    }) {
        return match
    }
    return sections.first { $0.contentText?.contains(query) ?? false }
}

// MARK: - paginateCliContent (UTF-16, port verbatim)

/// JS `MIN_MAX_CHARS`.
private let minMaxChars = 200

/// Port of cli.js `paginateCliContent(result, maxChars, pageNum)`. Operates on
/// UTF-16 code units so `length`/`slice`/`lastIndexOf` match JS exactly. Below the
/// floor → an error-content result with pageInfo cleared; content that fits in one
/// page → the result unchanged (no pageInfo). `content` is the already-unwrapped
/// `result.content`.
func paginateCliContent(_ result: LookupResult, content: String, maxChars: Int, pageNum: Int = 1) -> LookupResult {
    if maxChars < minMaxChars {
        var out = result
        out.content = "Error: --max-chars must be at least \(minMaxChars)"
        out.pageInfo = nil
        return out
    }
    let units = Array(content.utf16)
    if units.count <= maxChars {
        return result  // no pagination needed
    }
    let pages = splitPages(units, maxChars: maxChars)
    let totalPages = pages.count
    let pageNumber = max(1, min(pageNum, totalPages))

    var out = result
    out.content = String(decoding: pages[pageNumber - 1], as: UTF16.self)
    out.pageInfo = LookupPageInfo(
        page: pageNumber, totalPages: totalPages,
        hasNextPage: pageNumber < totalPages, hasPreviousPage: pageNumber > 1, strategy: "text-window")
    return out
}

/// Port of JS `splitPages(text, maxChars)` on UTF-16 code units: greedy, prefer a
/// `\n\n` break (cut after both), then a `\n` break (cut after it), then a hard cut
/// at maxChars. `slice(0, cut)` / `slice(cut)` semantics on code units.
private func splitPages(_ units: [UInt16], maxChars: Int) -> [[UInt16]] {
    if units.count <= maxChars { return [units] }

    var pages: [[UInt16]] = []
    var remaining = units[...]  // ArraySlice keeps the 0-based view across cuts

    while !remaining.isEmpty {
        let count = remaining.count
        if count <= maxChars {
            pages.append(Array(remaining))
            break
        }
        var cut = -1
        // Paragraph break: greatest start index ≤ maxChars of "\n\n".
        let paraSearch = lastIndexOfDoubleNewline(remaining, from: maxChars)
        if paraSearch > 0 { cut = paraSearch + 2 }  // include the double newline
        // Line break fallback.
        if cut <= 0 {
            let lineSearch = lastIndexOfNewline(remaining, from: maxChars)
            if lineSearch > 0 { cut = lineSearch + 1 }
        }
        // Hard cut.
        if cut <= 0 { cut = maxChars }

        // `slice(0, cut)` / `slice(cut)` over the current 0-based view.
        let base = remaining.startIndex
        let cutIndex = base + cut
        pages.append(Array(remaining[base ..< cutIndex]))
        remaining = remaining[cutIndex...]
    }
    return pages
}

/// JS `str.lastIndexOf('\n\n', maxChars)` over UTF-16 units: the greatest start
/// index `i` with `i <= maxChars`, `i+1` in range, and units[i]==units[i+1]==`\n`.
/// -1 when none. `from` is clamped so the start index can equal maxChars (JS
/// allows the match to START at the fromIndex).
private func lastIndexOfDoubleNewline(_ units: ArraySlice<UInt16>, from: Int) -> Int {
    let newline: UInt16 = 0x0A
    let count = units.count
    let base = units.startIndex
    // A 2-unit match starting at i needs i+1 <= count-1 ⇒ i <= count-2.
    var i = min(from, count - 2)
    while i >= 0 {
        if units[base + i] == newline, units[base + i + 1] == newline { return i }
        i -= 1
    }
    return -1
}

/// JS `str.lastIndexOf('\n', maxChars)` over UTF-16 units: the greatest index
/// `i <= maxChars` (clamped into range) with units[i]==`\n`, else -1.
private func lastIndexOfNewline(_ units: ArraySlice<UInt16>, from: Int) -> Int {
    let newline: UInt16 = 0x0A
    let count = units.count
    let base = units.startIndex
    var i = min(from, count - 1)
    while i >= 0 {
        if units[base + i] == newline { return i }
        i -= 1
    }
    return -1
}

// MARK: - projectReadDoc({ full: true })

/// Port of `projectReadDoc(payload, { full: true })` from output/projection.js.
/// Emits `found`, then (if present) `metadata` (allowlist + order), `content`
/// (string or null), `sections` (full projection), `note`, and `pageInfo`
/// (strategy dropped). The not-found branch drops everything but `found` (the
/// lookup result carries no note then).
func projectReadDoc(_ result: LookupResult) -> JSONValue {
    if !result.found {
        // JS: `payload.note ? {found:false, note} : {found:false}` — lookup's
        // not-found result has no note, so this is always `{found:false}`.
        if let note = result.note {
            return .obj([("found", .bool(false)), ("note", .string(note))])
        }
        return .obj([("found", .bool(false))])
    }

    var pairs: [(String, JSONValue)] = [("found", .bool(true))]
    if let metadata = result.metadata {
        pairs.append(("metadata", projectMetadata(metadata)))
    }
    // `payload.content !== undefined` — lookup always sets content (string or
    // nil), so the key is always emitted (null for the no-content/section-miss).
    pairs.append(("content", result.content.map(JSONValue.string) ?? .null))
    // `Array.isArray(payload.sections)` — always an array here → always emitted.
    pairs.append(("sections", .array(result.sections.map(projectSectionFull))))
    if let note = result.note {
        pairs.append(("note", .string(note)))
    }
    if let pageInfo = result.pageInfo {
        pairs.append(("pageInfo", projectPageInfo(pageInfo)))
    }
    return .obj(pairs)
}

/// `projectMetadata`: the METADATA_KEEP allowlist + order (title, framework,
/// rootSlug, roleHeading, kind, abstract, declaration, path, platforms,
/// relationships), each emitted only when "defined" (mirrors JS `pick`'s
/// `!== undefined`), then the truthy-only isDeprecated/isBeta flags.
///
/// "Defined" per field: title/framework/rootSlug/roleHeading/kind always exist on
/// the lookup metadata (value may be null → emitted as `null`). abstract /
/// declaration exist only on the PATH path (`abstractPresent`/`declarationPresent`).
/// path always exists. platforms always exists. relationships is emitted only when
/// non-empty (JS spreads it only then).
private func projectMetadata(_ m: LookupMetadata) -> JSONValue {
    var pairs: [(String, JSONValue)] = [
        ("title", m.title.map(JSONValue.string) ?? .null),
        ("framework", m.framework.map(JSONValue.string) ?? .null),
        ("rootSlug", m.rootSlug.map(JSONValue.string) ?? .null),
        ("roleHeading", m.roleHeading.map(JSONValue.string) ?? .null),
        ("kind", m.kind.map(JSONValue.string) ?? .null)
    ]
    if m.abstractPresent { pairs.append(("abstract", m.abstract.map(JSONValue.string) ?? .null)) }
    if m.declarationPresent { pairs.append(("declaration", m.declaration.map(JSONValue.string) ?? .null)) }
    pairs.append(("path", .string(m.path)))
    pairs.append(("platforms", m.platforms))
    if !m.relationships.isEmpty {
        pairs.append(("relationships", .obj(m.relationships.map { ($0.0, .int($0.1)) })))
    }
    if m.isDeprecated { pairs.append(("isDeprecated", .bool(true))) }
    if m.isBeta { pairs.append(("isBeta", .bool(true))) }
    return .obj(pairs)
}

/// `projectSectionFull(section)`: `{ heading?, contentText? }`. JS always sets the
/// `heading` key on a section row (value may be null → emitted), and emits
/// `contentText` only when `section.contentText ?? section.content_text !==
/// undefined` — i.e. only when contentText is non-nil (a nil contentText becomes
/// `null ?? undefined === undefined`, so the key is DROPPED, not emitted as null).
private func projectSectionFull(_ section: DocumentSectionRow) -> JSONValue {
    var pairs: [(String, JSONValue)] = [("heading", section.heading.map(JSONValue.string) ?? .null)]
    if let contentText = section.contentText {
        pairs.append(("contentText", .string(contentText)))
    }
    return .obj(pairs)
}

/// `projectPageInfo`: keep page/totalPages/hasNextPage/hasPreviousPage/totalItems
/// (DROP strategy). `totalItems` is never set by CLI pagination, so it's omitted.
private func projectPageInfo(_ pageInfo: LookupPageInfo) -> JSONValue {
    .obj([
        ("page", .int(Int64(pageInfo.page))),
        ("totalPages", .int(Int64(pageInfo.totalPages))),
        ("hasNextPage", .bool(pageInfo.hasNextPage)),
        ("hasPreviousPage", .bool(pageInfo.hasPreviousPage))
    ])
}
