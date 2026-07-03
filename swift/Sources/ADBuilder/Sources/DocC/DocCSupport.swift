// DocC-JSON normalizer — shared support (port of the helpers threaded through
// src/content/normalize/{docc,metadata,refs,relationships}.js).
//
// The normalizer parses the raw DocC JSON with ADJSONCore's reader (`JSON`), renders
// section TEXT by REUSING `ADContent.ContentText` (the native render-content.js), and
// builds each section's `contentJson` as an `ADJSONCore.JSONValue` re-serialized with the
// `.javaScript` profile — which is byte-for-byte `JSON.stringify`, so the pinned JS
// fixtures and the Swift output match to the byte (the `contentJson` strings are compared
// verbatim). Object key order is preserved via `OrderedDictionary`, matching JS object
// insertion order (and the JS spread `{ ...node, _resolvedKey }` append-at-end shape).
//
// PURE: no I/O, no ADWrite — a `(root, key, sourceType) → NormalizedPage` transform.

import ADBase
public import ADContent
public import ADJSONCore
import OrderedCollections

/// Namespace for the DocC-JSON normalizer.
public enum DocC {}

extension DocC {
    /// `JSON.stringify(value)` — the `.javaScript` encoding profile is documented as byte-for-byte
    /// with JavaScript's serializer (ECMA-262 numbers, minimal escaping, non-finite → null). A failure
    /// (only a pathological >1e6-deep tree, impossible for DocC) degrades to `"null"` rather than throw.
    static func stringify(_ value: JSONValue) -> String {
        guard let bytes = try? value.encodedBytes(options: .javaScript) else { return "null" }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// `String?` → a JSON string value or `null` (the JS `x ?? null` shape for a known-string field).
    @inline(__always)
    static func stringOrNull(_ text: String?) -> JSONValue { text.map(JSONValue.string) ?? .null }

    /// Materialize a node UNLESS it is absent/null, in which case `nil` — the JS `x ?? …` guard that
    /// keeps a falsy-but-present value (e.g. `""`, `0`, `false`) and only coalesces on null/undefined.
    @inline(__always)
    static func presentValue(_ node: JSON) -> JSONValue? {
        (node.exists && !node.isNull) ? JSONValue(node) : nil
    }

    /// `node ?? fallback` where the fallback is another JSON value (both materialized).
    @inline(__always)
    static func valueOr(_ node: JSON, _ fallback: JSONValue) -> JSONValue {
        presentValue(node) ?? fallback
    }

    /// Materialize an array member as a `[JSONValue]`, or `[]` when it is absent / not an array
    /// (the JS `x ?? []` over an array field).
    static func arrayOr(_ node: JSON) -> [JSONValue] {
        guard node.isArray else { return [] }
        var out: [JSONValue] = []
        out.reserveCapacity(node.count)
        node.forEachElement { out.append(JSONValue($0)) }
        return out
    }

    /// Build an ordered JSON object from an ordered key/value list — the single site that names
    /// `OrderedDictionary`, so reshaped `contentJson` objects keep their declared key order.
    static func object(_ pairs: [(String, JSONValue)]) -> JSONValue {
        var members = OrderedDictionary<String, JSONValue>(minimumCapacity: pairs.count)
        for (key, value) in pairs { members[key] = value }
        return .object(members)
    }

    /// `{ ...node, <extras> }` — the node's members in declared order, then the extra keys appended.
    /// A pre-existing extra key overrides in place (last-wins, first position), matching JS spread.
    static func appendMembers(_ node: JSON, _ extras: [(String, JSONValue)]) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        node.forEachMember { key, value in pairs.append((key, JSONValue(value))) }
        pairs.append(contentsOf: extras)
        return object(pairs)
    }

    /// `{ ...node, <key>: newValue }` — replace one member's value in place (or append if absent).
    static func replaceMember(_ node: JSON, _ key: String, _ newValue: JSONValue) -> JSONValue {
        var pairs: [(String, JSONValue)] = []
        var replaced = false
        node.forEachMember { memberKey, value in
            if memberKey == key {
                pairs.append((memberKey, newValue))
                replaced = true
            } else {
                pairs.append((memberKey, JSONValue(value)))
            }
        }
        if !replaced { pairs.append((key, newValue)) }
        return object(pairs)
    }

    // MARK: - text rendering (REUSE ADContent.ContentText — the native render-content.js)

    /// `renderContentNodesToText(nodes, refs)` — block nodes to plain text (joined with '').
    static func renderNodesText(_ nodes: JSON, _ ctx: DocCContext) -> String {
        var writer = ByteWriter()
        ContentText.renderNodes(nodes, refs: ctx.index, into: &writer)
        return String(decoding: writer.bytes, as: UTF8.self)
    }

    /// `renderInlineNodes(nodes, refs)` — inline nodes to plain text (joined with '').
    static func renderInlineText(_ nodes: JSON, _ ctx: DocCContext) -> String {
        var writer = ByteWriter()
        ContentText.renderInline(nodes, ctx.index, &writer)
        return String(decoding: writer.bytes, as: UTF8.self)
    }

    // MARK: - JS coercion helpers

    /// A non-empty JSON array (the `x?.length` / `x.length > 0` guard).
    @inline(__always)
    static func isNonEmptyArray(_ node: JSON) -> Bool { node.isArray && node.count > 0 }

    /// `${node ?? ''}` — the ECMAScript ToString of a present, non-null node, else `""`.
    @inline(__always)
    static func coerceOrEmpty(_ node: JSON) -> String {
        (node.exists && !node.isNull) ? node.jsString : ""
    }

    /// `x.content ? renderContentNodesToText(x.content, refs) : ''` — a description cell.
    @inline(__always)
    static func descriptionText(_ content: JSON, _ ctx: DocCContext) -> String {
        content.isTruthy ? renderNodesText(content, ctx) : ""
    }

    /// `key.split('/')[0]` — the first path segment (up to the first `/`), or the whole key.
    static func firstPathSegment(_ key: String) -> String {
        String(key.prefix { $0 != "/" })
    }

    /// JavaScript `String.prototype.trim()` — strip the ECMAScript WhiteSpace + LineTerminator set
    /// from both ends (a superset of ASCII space/tab/newline: NBSP, the Unicode spaces, BOM, …).
    static func trimJS(_ text: String) -> String {
        let scalars = text.unicodeScalars
        var start = scalars.startIndex
        var end = scalars.endIndex
        while start < end, isJSWhitespace(scalars[start]) { start = scalars.index(after: start) }
        while end > start, isJSWhitespace(scalars[scalars.index(before: end)]) {
            end = scalars.index(before: end)
        }
        return String(String.UnicodeScalarView(scalars[start ..< end]))
    }

    private static func isJSWhitespace(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2028, 0x2029,
                0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            case 0x2000 ... 0x200A:
                return true
            default:
                return false
        }
    }
}

/// A per-page resolution context: the `references` map (kept raw for iteration + wrapped in an O(1)
/// lookup index) and the key mapper (identity for the base normalize; adapters override in B3). All
/// of the reference-resolving helpers hang off this so the reference index is built ONCE per page.
struct DocCContext {
    let references: JSON
    let index: PageMarkdown.Refs
    let keyMapper: (String) -> String

    init(references: JSON, keyMapper: @escaping (String) -> String) {
        self.references = references
        self.index = PageMarkdown.Refs(references: references.isObject ? references : nil)
        self.keyMapper = keyMapper
    }

    /// `refs?.[id]` narrowed to an object node (the JS `ref?.…` accesses only make sense on objects).
    func lookup(_ id: String?) -> JSON? { id.flatMap { index.lookup($0) } }

    /// Apply the (identity-by-default) key mapper to a resolved key, preserving `nil` — the JS
    /// `mapKey(resolveRefKey(id, refs))` where `identity(null) === null`.
    @inline(__always)
    func mapKey(_ key: String?) -> String? { key.map(keyMapper) }

    /// `resolveRefKey(id, refs)` (refs.js): the reference's `url` via `normalizeIdentifier`, else via
    /// the cross-source URL→key map, else the identifier itself via `normalizeIdentifier`. May be `nil`.
    func resolveRefKey(_ id: String?) -> String? {
        guard let id else { return nil }
        if let ref = lookup(id), let url = ref["url"].string, !url.isEmpty {
            if let norm = Identifier.normalize(url) { return norm }
            if let mapped = LinkResolver.mapUrlToKey(url) { return mapped }
        }
        return Identifier.normalize(id)
    }

    /// `mapKey(resolveRefKey(id))` as a JSON value (`null` when unresolved) — the always-emitted
    /// `_resolvedKey` shape.
    @inline(__always)
    func resolvedKeyValue(_ id: String?) -> JSONValue { DocC.stringOrNull(mapKey(resolveRefKey(id))) }

    /// `ref?.title` as a present value (kept even when `""`), or `nil` for a null/absent title —
    /// the first arm of the `ref?.title ?? … ?? null` chains.
    func refTitleValue(_ ref: JSON?) -> JSONValue? {
        guard let ref else { return nil }
        return DocC.presentValue(ref["title"])
    }
}
