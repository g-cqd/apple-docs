// S5 render-loop support: the /fonts embedded-JSON builder (listAppleFonts
// parity) and the topics-section role-heading enrichment
// (templates/document.js `enrichTopicItems`). Both must reproduce
// `JSON.stringify` output byte-for-byte, so they build through `JsonLd`
// (insertion-ordered stringify twin) with ECMA number rendering.

import ADBase
import ADJSONCore

public import ADContent

// MARK: - JSON → JsonLd (stringify-normalizing bridge)

extension BuildSite {
    /// Convert a parsed `JSON` node to `JsonLd`, preserving document order.
    /// Numbers render via the ECMA `String(n)` form (`jsNumberString`) — the
    /// same normalization `JSON.parse` → `JSON.stringify` applies (`1.50` →
    /// `1.5`), so round-tripping a sub-document through this bridge matches
    /// the JS re-serialization byte-for-byte.
    static func jsonLdValue(_ node: JSON) -> JsonLd {
        if node.isNull { return .null }
        if let flag = node.bool { return .bool(flag) }
        if let number = node.jsNumberString { return .verbatim(number) }
        if let string = node.string { return .string(string) }
        if node.isArray {
            var items: [JsonLd] = []
            node.forEachElement { items.append(jsonLdValue($0)) }
            return .array(items)
        }
        if node.isObject {
            var pairs: [(String, JsonLd)] = []
            node.forEachMember { key, value in pairs.append((key, jsonLdValue(value))) }
            return .object(pairs)
        }
        return .null  // absent node — unreachable from a parsed document
    }
}

// MARK: - fonts embedded JSON (listAppleFonts → JSON.stringify parity)

/// A dynamic row: (column name, cell) pairs in SELECT column order — mirrors
/// the object `bun:sqlite` hands back for `SELECT *`.
public struct FontRow: Sendable {
    public let cells: [(name: String, value: FontCell)]
    public init(cells: [(name: String, value: FontCell)]) {
        self.cells = cells
    }
}

/// One SQLite cell as the JS row object sees it.
public enum FontCell: Sendable {
    case text(String)
    case integer(Int64)
    case real(Double)
    case null
}

extension BuildSite {
    /// Port of `listAppleFonts()` (repos/assets-fonts.js `listFonts` +
    /// `normalizeAppleFontFile`) → the exact `JSON.stringify(families)` text
    /// the /fonts page embeds. Families in `ORDER BY display_name` with their
    /// full row spread; each family gains `files` LAST — files in
    /// `ORDER BY family_id, file_name`, full row spread with `italic` /
    /// `is_variable` coerced to booleans IN PLACE and `axes`
    /// (= parseJsonArray(axes_json): the parsed array, else `[]`) appended.
    /// Returns nil when the corpus has no font tables (the page renders its
    /// empty shell, like a fonts-less JS corpus returning `[]`… which the JS
    /// serializes as `[]` — callers pass `[]` semantics through `families`).
    public static func fontsFamiliesJson(families: [FontRow]?, files: [FontRow]?) -> String? {
        guard let families else { return nil }
        let filesByFamily = groupFontFiles(files ?? [])
        var out: [JsonLd] = []
        out.reserveCapacity(families.count)
        for family in families {
            var pairs: [(String, JsonLd)] = family.cells.map { ($0.name, fontCellValue($0.value)) }
            let familyId = textCell(family, "id") ?? ""
            let familyFiles = filesByFamily[familyId] ?? []
            pairs.append(("files", .array(familyFiles)))
            out.append(.object(pairs))
        }
        return JsonLd.array(out).serialized()
    }

    /// files grouped by family_id (insertion order preserved inside a family),
    /// each mapped through `normalizeAppleFontFile`.
    private static func groupFontFiles(_ files: [FontRow]) -> [String: [JsonLd]] {
        var byFamily: [String: [JsonLd]] = [:]
        for file in files {
            var pairs: [(String, JsonLd)] = []
            pairs.reserveCapacity(file.cells.count + 1)
            var axesJson: String?
            for cell in file.cells {
                switch cell.name {
                case "italic", "is_variable":
                    // `row.italic === 1 || row.italic === true` — SQLite gives 0/1.
                    if case .integer(let raw) = cell.value {
                        pairs.append((cell.name, .bool(raw == 1)))
                    } else {
                        pairs.append((cell.name, .bool(false)))
                    }
                case "axes_json":
                    if case .text(let text) = cell.value { axesJson = text }
                    pairs.append((cell.name, fontCellValue(cell.value)))
                default:
                    pairs.append((cell.name, fontCellValue(cell.value)))
                }
            }
            // `axes: parseJsonArray(row.axes_json)` — the parsed ARRAY, else [].
            pairs.append(("axes", parseJsonArrayValue(axesJson)))
            let familyId = textCell(file, "family_id") ?? ""
            byFamily[familyId, default: []].append(.object(pairs))
        }
        return byFamily
    }

    private static func fontCellValue(_ cell: FontCell) -> JsonLd {
        switch cell {
        case .text(let s): return .string(s)
        case .integer(let i): return .verbatim(String(i))
        case .real(let d): return .verbatim(JSONOutput.ecmaNumberToString(d))
        case .null: return .null
        }
    }

    private static func textCell(_ row: FontRow, _ name: String) -> String? {
        for cell in row.cells where cell.name == name {
            if case .text(let s) = cell.value { return s }
        }
        return nil
    }

    /// `parseJsonArray(value)` — parse; an array passes (normalized through the
    /// stringify bridge), anything else (null / scalar / object / bad JSON) → [].
    private static func parseJsonArrayValue(_ text: String?) -> JsonLd {
        guard let text, !text.isEmpty,
            let root = try? ADJSON.parse(text, options: .init(maxDepth: 512)).root,
            root.isArray
        else { return .array([]) }
        return jsonLdValue(root)
    }
}

// MARK: - framework listing rows → [JSON]

/// One `getPagesByRoot` row (getDocumentsByRoot's aliased SELECT): the
/// framework page's doc-list shape. Null members are emitted explicitly, like
/// the JS row objects the template reads.
public struct FrameworkListingDoc: Sendable {
    public let path: String
    public let title: String?
    public let role: String?
    public let roleHeading: String?
    public let abstract: String?
    public let sourceMetadata: String?
    public let framework: String?
    public init(
        path: String, title: String?, role: String?, roleHeading: String?, abstract: String?,
        sourceMetadata: String?, framework: String?
    ) {
        self.path = path
        self.title = title
        self.role = role
        self.roleHeading = roleHeading
        self.abstract = abstract
        self.sourceMetadata = sourceMetadata
        self.framework = framework
    }
}

extension BuildSite {
    /// The rows as a JSON array text (`path, title, role, role_heading,
    /// abstract, source_metadata, framework` — the SELECT's column order) for
    /// re-parsing into the `[JSON]` the framework page renders.
    public static func frameworkDocsJson(_ docs: [FrameworkListingDoc]) -> String {
        func opt(_ value: String?) -> JsonLd { value.map(JsonLd.string) ?? .null }
        return JsonLd.array(
            docs.map { doc in
                .object([
                    ("path", .string(doc.path)),
                    ("title", opt(doc.title)),
                    ("role", opt(doc.role)),
                    ("role_heading", opt(doc.roleHeading)),
                    ("abstract", opt(doc.abstract)),
                    ("source_metadata", opt(doc.sourceMetadata)),
                    ("framework", opt(doc.framework)),
                ])
            }
        ).serialized()
    }
}

// MARK: - checkpoint digests (build/checkpoint.js)

extension BuildSite {
    /// Port of `computeSectionsDigest(sections)` — the cheap SHAPE fingerprint
    /// the incremental skip compares: per section `section_kind`,
    /// `(content_text ?? '').length` (UTF-16 units), the content_json length
    /// (or '1'/'0' for non-string truthiness — always a string or null here),
    /// and `String(sort_order)` (ECMA number form), joined with '|', then
    /// `sha256(...).slice(0, 16)`. Empty sections ⇒ 'empty'. A null
    /// section_kind joins as '' (JS Array.join null coercion).
    public static func computeSectionsDigest(_ sections: [DocSection]) -> String {
        if sections.isEmpty { return "empty" }
        var parts: [String] = []
        parts.reserveCapacity(sections.count * 4)
        for section in sections {
            parts.append(section.sectionKind ?? "")
            parts.append(String((section.contentText ?? "").utf16.count))
            parts.append(section.contentJson.map { String($0.utf16.count) } ?? "0")
            parts.append(JSONOutput.ecmaNumberToString(section.sortOrder))
        }
        return String(Sha256.hexString(parts.joined(separator: "|")).prefix(16))
    }

    /// `sha256(html).slice(0, 16)` — the render-index html_hash.
    static func htmlHash(_ bytes: [UInt8]) -> String {
        String(Sha256.hex(Sha256.digest(bytes)).prefix(16))
    }
}

// MARK: - enrichTopicItems (templates/document.js)

extension BuildSite {
    /// Port of `enrichTopicItems(sections, resolveRoleHeadings)`: for each
    /// `topics` section whose content_json parses to an ARRAY, collect
    /// `group.items[].key`, batch-resolve role headings, set
    /// `_resolvedRoleHeading` on matched items (appended LAST — JS property
    /// creation order), and write the section's contentJSON back as the
    /// re-`JSON.stringify`ed text. Sections without keys — or with unparseable
    /// JSON — pass through untouched (the JS `continue` paths).
    public static func enrichTopicSections(
        _ sections: [DocSection], resolveRoleHeadings: ([String]) -> [String: String]
    ) -> [DocSection] {
        sections.map { section in
            guard section.sectionKind == "topics", let raw = section.contentJson,
                let root = try? ADJSON.parse(raw, options: .init(maxDepth: 512)).root,
                root.isArray
            else { return section }

            // Collect all item keys.
            var keys: [String] = []
            root.forEachElement { group in
                group["items"].forEachElement { item in
                    if let key = item["key"].string, !key.isEmpty { keys.append(key) }
                }
            }
            guard !keys.isEmpty else { return section }

            let roleMap = resolveRoleHeadings(keys)

            // Rebuild the array with `_resolvedRoleHeading` injected into
            // matched items (all other structure normalized through the
            // stringify bridge, exactly like the JS parse → mutate → stringify).
            var groups: [JsonLd] = []
            root.forEachElement { group in
                guard group.isObject else {
                    groups.append(jsonLdValue(group))
                    return
                }
                var groupPairs: [(String, JsonLd)] = []
                group.forEachMember { name, value in
                    if name == "items", value.isArray {
                        var items: [JsonLd] = []
                        value.forEachElement { item in
                            guard item.isObject else {
                                items.append(jsonLdValue(item))
                                return
                            }
                            var itemPairs: [(String, JsonLd)] = []
                            item.forEachMember { itemKey, itemValue in
                                itemPairs.append((itemKey, jsonLdValue(itemValue)))
                            }
                            if let key = item["key"].string, let heading = roleMap[key] {
                                itemPairs.append(("_resolvedRoleHeading", .string(heading)))
                            }
                            items.append(.object(itemPairs))
                        }
                        groupPairs.append((name, .array(items)))
                    } else {
                        groupPairs.append((name, jsonLdValue(value)))
                    }
                }
                groups.append(.object(groupPairs))
            }
            let serialized = JsonLd.array(groups).serialized()
            return DocSection(
                sectionKind: section.sectionKind, heading: section.heading,
                contentText: section.contentText, contentJson: serialized,
                sortOrder: section.sortOrder)
        }
    }
}
