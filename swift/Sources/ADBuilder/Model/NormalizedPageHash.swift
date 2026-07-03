// The JS `content_hash` preimage (src/pipeline/persist.js): `stableStringify(normalized)` — the
// `{ document, sections, relationships }` object serialized as MINIFIED JSON with recursively
// SORTED object keys and JS number formatting (src/storage/files.js `stableStringify`). SHA-256 of
// this string is the documents/pages `content_hash`; computing the preimage in Swift is what makes
// the native crawl's content_hash match the Bun writer (CrawlDriver's noted follow-up).
//
// Every JS-optional field is emitted as an explicit `null` (JS objects carry the key with a null
// value — `JSON.stringify` keeps it), so the byte stream matches the JS `normalized` object exactly.

import ADJSONCore
import OrderedCollections

extension NormalizedPage {
    /// `stableStringify(normalized)` — the minified, key-sorted JSON of `{ document, sections,
    /// relationships }` (the SHA-256 preimage the JS `content_hash` hashes).
    public func stableStringified() -> String {
        let value = DocC.object([
            ("document", Self.documentValue(document)),
            ("sections", .array(sections.map(Self.sectionValue))),
            ("relationships", .array(relationships.map(Self.relationshipValue))),
        ])
        // stableStringify = JSON.stringify(obj, sortReplacer): compact, ECMA-262 numbers, non-finite
        // → null, and (the replacer) recursively lexicographic object keys. Arrays keep order.
        let options = JSONEncodingOptions(nonFinite: .null, numberFormat: .ecma262, keyOrder: .sorted)
        guard let bytes = try? value.encodedBytes(options: options) else { return "null" }
        return String(decoding: bytes, as: UTF8.self)
    }

    private static func documentValue(_ document: NormalizedDocument) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        pairs.append(("sourceType", DocC.stringOrNull(document.sourceType)))
        pairs.append(("key", .string(document.key)))
        pairs.append(("title", DocC.stringOrNull(document.title)))
        pairs.append(("kind", DocC.stringOrNull(document.kind)))
        pairs.append(("role", DocC.stringOrNull(document.role)))
        pairs.append(("roleHeading", DocC.stringOrNull(document.roleHeading)))
        pairs.append(("framework", DocC.stringOrNull(document.framework)))
        pairs.append(("url", DocC.stringOrNull(document.url)))
        pairs.append(("language", DocC.stringOrNull(document.language)))
        pairs.append(("abstractText", DocC.stringOrNull(document.abstractText)))
        pairs.append(("declarationText", DocC.stringOrNull(document.declarationText)))
        pairs.append(("platformsJson", DocC.stringOrNull(document.platformsJson)))
        pairs.append(("minIos", DocC.stringOrNull(document.minIos)))
        pairs.append(("minMacos", DocC.stringOrNull(document.minMacos)))
        pairs.append(("minWatchos", DocC.stringOrNull(document.minWatchos)))
        pairs.append(("minTvos", DocC.stringOrNull(document.minTvos)))
        pairs.append(("minVisionos", DocC.stringOrNull(document.minVisionos)))
        pairs.append(("isDeprecated", boolOrNull(document.isDeprecated)))
        pairs.append(("isBeta", boolOrNull(document.isBeta)))
        pairs.append(("isReleaseNotes", boolOrNull(document.isReleaseNotes)))
        pairs.append(("urlDepth", intOrNull(document.urlDepth)))
        pairs.append(("headings", DocC.stringOrNull(document.headings)))
        pairs.append(("sourceMetadata", DocC.stringOrNull(document.sourceMetadata)))
        return DocC.object(pairs)
    }

    private static func sectionValue(_ section: NormalizedSection) -> JSONValue {
        DocC.object([
            ("sectionKind", .string(section.sectionKind)),
            ("heading", DocC.stringOrNull(section.heading)),
            ("contentText", DocC.stringOrNull(section.contentText)),
            ("contentJson", DocC.stringOrNull(section.contentJson)),
            ("sortOrder", .int(Int64(section.sortOrder))),
        ])
    }

    private static func relationshipValue(_ relationship: NormalizedRelationship) -> JSONValue {
        DocC.object([
            ("fromKey", DocC.stringOrNull(relationship.fromKey)),
            ("toKey", .string(relationship.toKey)),
            ("relationType", .string(relationship.relationType)),
            ("section", DocC.stringOrNull(relationship.section)),
            ("sortOrder", intOrNull(relationship.sortOrder)),
        ])
    }

    private static func boolOrNull(_ value: Bool?) -> JSONValue { value.map(JSONValue.bool) ?? .null }
    private static func intOrNull(_ value: Int?) -> JSONValue { value.map { .int(Int64($0)) } ?? .null }
}
