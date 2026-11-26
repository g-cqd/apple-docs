import AemiJSONCore

/// Reads the structured `document_sections.content_json` payloads written by the Bun pipeline (and imported by
/// `import-v31`), whose `content_text` is flattened plain text meant for full-text search only.
///
/// Block-node payloads (discussion, nested content) and named-item payloads (parameters, properties) render
/// to the same Markdown flavour Swift-synced sections store in `content_text`; reference lists (mentioned in)
/// expose their resolved keys so readers can link them.
public enum StoredSectionContent {
    /// One resolved document reference from a reference-list payload.
    public struct Link: Hashable, Sendable {
        public let key: String
        public let title: String
    }

    /// Markdown for a `content_json` payload, or `nil` when the payload is not a renderable shape.
    public static func markdown(contentJSON: String) -> String? {
        guard let root = try? AemiJSON.parse(Array(contentJSON.utf8)).root, let items = root.array, !items.isEmpty
        else { return nil }
        let refs = root["references"]  // absent on arrays: references resolve to their last path component
        if items.allSatisfy({ $0["type"].string != nil }) {
            let first = DocCContentRenderer.firstHeading(items, refs: refs)
            let text = DocCContentRenderer.renderBlocks(items, refs: refs, skippingFirstHeading: first != nil)
            return text.isEmpty ? nil : text
        }
        if items.allSatisfy({ $0["name"].string != nil }) {
            let lines = items.compactMap { DocCContentRenderer.namedItemLine($0, refs: refs) }
            return lines.joined(separator: "\n")
        }
        return nil
    }

    /// The `{key, title}` entries of a reference-list payload (e.g. `mentioned_in`), in order.
    public static func links(contentJSON: String) -> [Link] {
        guard let root = try? AemiJSON.parse(Array(contentJSON.utf8)).root, let items = root.array else { return [] }
        return items.compactMap { item in
            guard let key = item["key"].string, !key.isEmpty else { return nil }
            return Link(key: key, title: item["title"].string ?? key)
        }
    }
}
