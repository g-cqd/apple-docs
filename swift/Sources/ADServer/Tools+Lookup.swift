// The read_doc "lookup" resolution (path/symbol → metadata + content +
// sections + note) and the search-hit JSON projection, shared by the
// `read_doc` tool and `search_docs`' `read=true` mode (both build the exact
// same document envelope before the match-excerpt / pagination steps in
// `MatchExcerpt.swift` / `DocumentPagination.swift`). Split from Tools.swift
// to keep that file within the size gate.

import ADContent
import ADJSON
import ADSearchCascade
// `MCPToolContext`/`MCPToolResult` are `ADMCP` types, re-exported (`@_exported
// import ADMCP`) by `ADServeCore/MCPReExport.swift` — `MemberImportVisibility`
// requires importing that carrier directly in every file that names them.
import ADServeCore
import ADStorage

/// One resolved page: the metadata/content/sections/note read_doc's `lookup()`
/// equivalent builds, PLUS the `DocMarkdownDocument` view needed to re-render
/// a subset of sections (the section-bucket pagination strategy).
struct ResolvedDocument {
    var record: DocumentRecord
    var metadata: OrderedDictionary<String, JSONValue>
    var content: String?
    /// ALWAYS the full section list (rendering + matching need them);
    /// whether they are ALSO RETURNED to the client is a separate decision
    /// the caller makes (`includeSections`).
    var sections: [DocumentSectionRow]
    var note: String
}

/// lookup(): resolve `path` (with a normalize-identifier retry) or `symbol` to
/// a `DocumentRecord`, then render its Markdown + assemble the public
/// metadata + relationship counts + note exactly as the JS command. `nil`
/// when neither resolves (the caller returns `{found:false}`, un-touched by
/// pagination — see `Tools.swift`'s `readDoc` / `readTopHit` below).
func resolveDocument(path: String?, symbol: String?, framework: String?, conn: StorageConnection)
    -> ResolvedDocument?
{
    var record: DocumentRecord?
    if let path {
        record = conn.readDocument(path)
        if record == nil, let normalized = normalizeIdentifier(path), normalized != path {
            record = conn.readDocument(normalized)
        }
    } else if let symbol {
        record = conn.searchByTitle(symbol, framework: framework)
    }
    guard let page = record else { return nil }

    let pagePath = page.path
    // Content: JS `lookup` renders INDEPENDENTLY of includeSections — it always
    // loads the DB sections and, when present, renders Markdown on-demand
    // (fallback=true). The in-process server has no persisted .md and no
    // raw-json/hydrate path, so the section render is the one reachable source;
    // an empty section list leaves content null (→ the tier note).
    let sections = conn.documentSections(pagePath)
    let rendered = sections.isEmpty ? nil : renderDocMarkdown(page, sections)
    let relationships = relationshipCountsObject(conn.relationshipCountsByType(pagePath))

    // projectMetadata's pick keep-order: title, framework, rootSlug, roleHeading,
    // kind, abstract, declaration, path, platforms, relationships — then the
    // isDeprecated / isBeta flags (true-only).
    var metadata: OrderedDictionary<String, JSONValue> = [
        "title": page.title.map(JSONValue.string) ?? .null,
        "framework": page.frameworkDisplay.map(JSONValue.string) ?? .null,
        "rootSlug": page.rootSlug.map(JSONValue.string) ?? .null,
        "roleHeading": page.roleHeading.map(JSONValue.string) ?? .null,
        "kind": page.kind.map(JSONValue.string) ?? .null,
        "abstract": page.abstract.map(JSONValue.string) ?? .null,
        "declaration": page.declaration.map(JSONValue.string) ?? .null,
        "path": .string(pagePath), "platforms": platformsValue(page.platformsJSON)
    ]
    if let relationships { metadata["relationships"] = relationships }
    if page.isDeprecated { metadata["isDeprecated"] = .bool(true) }
    if page.isBeta { metadata["isBeta"] = .bool(true) }

    // Note: when content rendered, JS emits the on-demand-fallback note (the
    // in-process render always sets fallback=true); otherwise the tier note —
    // lite-tier snapshots get the tier-limitation hint, every other tier the
    // sync hint.
    let note: String =
        if rendered != nil {
            "Rendered on-demand from normalized content."
        } else if conn.snapshotTier() == "lite" {
            "Content body unavailable on a legacy lite-tier snapshot. Metadata and declaration shown."
        } else {
            "No content available. Run apple-docs sync first."
        }

    return ResolvedDocument(record: page, metadata: metadata, content: rendered, sections: sections, note: note)
}

/// `input.section`: return ONE matching section's raw text (bypassing
/// match/pagination entirely — JS's `lookup()` has its own early return for
/// this, before the MCP handler's match/paginate steps ever run).
func sectionResult(_ resolved: ResolvedDocument, query: String) -> MCPToolResult {
    if let match = findSection(resolved.sections, query: query) {
        return .okValue(
            .object([
                "found": .bool(true), "metadata": .object(resolved.metadata),
                "content": .string(match.contentText ?? "Section content not available."),
                "sections": .array([projectSectionFull(match)])
            ]))
    }
    let available = resolved.sections.compactMap { $0.heading ?? $0.sectionKind }.joined(separator: ", ")
    return .okValue(
        .object([
            "found": .bool(true), "metadata": .object(resolved.metadata), "content": .null,
            "sections": .array(resolved.sections.map(projectSectionFull)),
            "note": .string("Section not found: \(query). Available sections: \(available)")
        ]))
}

/// `buildMatchedDocumentPayload`, applied in place: narrows `envelope` to the
/// match excerpts, dropping content/sections/note per JS's `{...payload,
/// content: null, matches, sections: [], note: ...}`.
func applyMatch(_ match: MatchExcerpt, sections: [DocumentSectionRow], to envelope: inout Pagination.DocumentEnvelope) {
    let result = MatchExcerpts.build(
        sections: sections,
        options: .init(
            query: match.query, contextChars: match.context ?? 140, maxMatches: match.max ?? 5,
            caseSensitive: match.caseSensitive ?? false))
    envelope.content = nil
    envelope.sections = []
    envelope.matches = result.matches
    envelope.note = result.note
}

// MARK: - search_docs `read=true`

/// search_docs `read=true`: inline the top hit's full document, reusing
/// read_doc's exact envelope + match/pagination machinery, embedding the hit
/// as `bestMatch` (JS: `{bestMatch: hit, metadata: page.metadata, ...}`).
func readTopHit(
    _ hit: SearchHitView, match: MatchExcerpt?, maxChars: Int?, page: Int, ctx: MCPToolContext
) -> MCPToolResult {
    guard let resolved = resolveDocument(path: hit.path, symbol: nil, framework: nil, conn: ctx.db) else {
        return .okValue(.object(["found": .bool(false)]))
    }

    let includeSections = maxChars != nil || match != nil
    var envelope = Pagination.DocumentEnvelope(
        metadata: .object(resolved.metadata), content: resolved.content,
        sections: includeSections ? resolved.sections : [], note: resolved.note, matches: nil,
        bestMatch: searchHitJSON(hit), renderDocument: docMarkdownDocument(resolved.record))

    if let match { applyMatch(match, sections: resolved.sections, to: &envelope) }

    let full = match != nil || maxChars != nil
    do {
        return .okValue(
            try Pagination.buildDocumentResult(envelope, maxChars: maxChars, page: page, full: full))
    } catch {
        return .failure(error.message)
    }
}

/// The non-`read` (or `read`-but-no-hits) search_docs payload: `{query,
/// total, hasMore, results, approximate?}`, array-paginated over `results`
/// when `maxChars` is set. Mirrors `projectSearchResult`'s field order.
func searchResultsPayload(_ outcome: SearchOutcome, maxChars: Int?, page: Int) -> MCPToolResult {
    let items = outcome.hits.map(searchHitJSON)
    var base: OrderedDictionary<String, JSONValue> = [
        "query": .string(outcome.query), "total": .int(Int64(outcome.total)), "hasMore": .bool(outcome.hasMore)
    ]
    let approximate = outcome.hits.contains { $0.confidence == "approximate" }

    guard let maxChars else {
        base["results"] = .array(items)
        if approximate { base["approximate"] = .bool(true) }
        return .okValue(.object(base))
    }
    do {
        return .okValue(
            try Pagination.paginateArray(items: items, maxChars: maxChars, page: page) {
                slice, pageIndex, totalPages in
                var out = base
                out["results"] = .array(Array(slice))
                if approximate { out["approximate"] = .bool(true) }
                out["pageInfo"] = Pagination.pageInfoJSON(
                    page: pageIndex, totalPages: totalPages, totalItems: items.count)
                return .object(out)
            })
    } catch {
        return .failure(error.message)
    }
}

/// `projectSearchHit`'s exact field order: path, title, framework, rootSlug,
/// kind, sourceType, abstract, declaration, platforms, language, snippet?,
/// relatedCount?, confidence, isDeprecated?, isBeta?, isReleaseNotes?.
func searchHitJSON(_ hit: SearchHitView) -> JSONValue {
    var out: OrderedDictionary<String, JSONValue> = [
        "path": .string(hit.path), "title": hit.title.map(JSONValue.string) ?? .null,
        "framework": hit.framework.map(JSONValue.string) ?? .null,
        "rootSlug": hit.rootSlug.map(JSONValue.string) ?? .null,
        "kind": hit.kind.map(JSONValue.string) ?? .null,
        "sourceType": hit.sourceType.map(JSONValue.string) ?? .null,
        "abstract": hit.abstract.map(JSONValue.string) ?? .null,
        "declaration": hit.declaration.map(JSONValue.string) ?? .null,
        "platforms": platformsValue(hit.platforms), "language": hit.language.map(JSONValue.string) ?? .null
    ]
    if let snippet = hit.snippet { out["snippet"] = .string(snippet) }
    if let relatedCount = hit.relatedCount { out["relatedCount"] = .int(Int64(relatedCount)) }
    out["confidence"] = .string(hit.confidence)
    if hit.isDeprecated { out["isDeprecated"] = .bool(true) }
    if hit.isBeta { out["isBeta"] = .bool(true) }
    if hit.isReleaseNotes { out["isReleaseNotes"] = .bool(true) }
    return .object(out)
}

// MARK: - Markdown rendering (render-markdown.js)

/// `renderMarkdown({ ...page, key: pagePath }, sections)` over the in-process
/// document + section rows, with the default render flags (includeFrontMatter,
/// includeTitle = true) matching lookup's bare `renderMarkdown(document,
/// sections)` call. Shared by read_doc, search_docs(read=true), and the doc
/// resource (`Resources.swift`) so their bytes never diverge.
func renderDocMarkdown(_ page: DocumentRecord, _ sections: [DocumentSectionRow]) -> String {
    DocMarkdown.render(document: docMarkdownDocument(page), sections: sections.map(docMarkdownSection))
}

/// The `DocMarkdownDocument` view of a resolved page — shared by the whole-
/// document render above, `readDoc`/`readTopHit`'s `Pagination.DocumentEnvelope`
/// construction, and the section-bucket paginator's per-page re-render
/// (`DocumentPagination.swift`), so all three stay byte-identical. Not
/// `private`: called from `Tools.swift` too.
func docMarkdownDocument(_ page: DocumentRecord) -> DocMarkdownDocument {
    DocMarkdownDocument(
        key: page.path, title: page.title, framework: page.framework,
        frameworkDisplay: page.frameworkDisplay, role: page.role, roleHeading: page.roleHeading,
        platformsJSON: page.platformsJSON)
}

/// The `DocMarkdownSection` view of one row — shared the same way.
private func docMarkdownSection(_ section: DocumentSectionRow) -> DocMarkdownSection {
    DocMarkdownSection(
        kind: section.sectionKind, heading: section.heading, contentText: section.contentText ?? "",
        contentJSON: section.contentJSON, sortOrder: section.sortOrder)
}

// MARK: - metadata support

/// getRelationshipCountsByType → projectMetadata's `relationships` object:
/// relation_type mapped to camelCase (unmapped types dropped), counts as `.int`
/// so they serialize as `2` not `2.0`. nil when the object would be empty (the
/// projection drops the key).
private func relationshipCountsObject(_ counts: [RelationshipCount]) -> JSONValue? {
    var out: OrderedDictionary<String, JSONValue> = [:]
    for entry in counts {
        guard let camel = relationTypeToCamel(entry.relationType) else { continue }
        out[camel] = .int(Int64(entry.count))
    }
    return out.isEmpty ? nil : .object(out)
}

/// RELATION_TYPE_TO_CAMEL: DB relation_type slug → camelCase public name.
/// Anything not listed is dropped (a future relation_type never leaks).
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
/// (array OR object) when the column is a non-empty string, else `[]`.
private func platformsValue(_ json: String?) -> JSONValue {
    guard let json, !json.isEmpty, let value = try? JSONValue(parsing: json) else { return .array([]) }
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

/// projectSectionFull(section): { heading?, contentText? } — keys present only
/// when defined (null kept). Shared with `DocumentPagination.swift`'s
/// `assembleDocument`, so not `private`.
func projectSectionFull(_ section: DocumentSectionRow) -> JSONValue {
    var out: OrderedDictionary<String, JSONValue> = [:]
    out["heading"] = section.heading.map(JSONValue.string) ?? .null
    out["contentText"] = section.contentText.map(JSONValue.string) ?? .null
    return .object(out)
}

/// sectionSkeleton(section): { heading, chars } — chars is the contentText
/// length (UTF-16 code-unit count, matching JS String.length), as `.int`.
/// Shared with `DocumentPagination.swift`'s `assembleDocument`, so not `private`.
func sectionSkeleton(_ section: DocumentSectionRow) -> JSONValue {
    let chars = section.contentText.map { $0.utf16.count } ?? 0
    return .object([
        "heading": section.heading.map(JSONValue.string) ?? .null, "chars": .int(Int64(chars))
    ])
}
