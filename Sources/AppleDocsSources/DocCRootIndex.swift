import AemiJSONCore

/// A documentation root's navigation index (`/tutorials/data/index/<slug>`), which Apple republishes whenever any
/// page under the root changes: an unchanged index (304, or identical bytes) lets a re-sync skip every page of the
/// root. Port of Bun's `fetchRootIndex` (`apple/api.js`) and `seedNewPagesFromIndex` (`update/docc.js`).
public enum DocCRootIndex {
    public enum FetchOutcome: Equatable, Sendable {
        case unchanged
        case modified(body: [UInt8], etag: String?)
        case missing
    }

    /// One page listed by the index.
    public struct Page: Equatable, Sendable {
        public let key: String
        public let depth: Int
    }

    public static func url(forRoot slug: String) -> String {
        "https://developer.apple.com/tutorials/data/index/\(slug)"
    }

    /// Conditional GET of the root's index (`If-None-Match` with the stored ETag).
    public static func fetch(
        rootSlug: String,
        etag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> FetchOutcome {
        switch try await client.conditionalGet(url: url(forRoot: rootSlug), etag: etag) {
            case .notModified: .unchanged
            case .gone: .missing
            case .ok(let response): .modified(body: response.body, etag: response.etag)
        }
    }

    /// The index's `/documentation/<root>/…` pages (lowercased keys, depth = segments - 1), first occurrence wins,
    /// skipping external entries and paths outside the root.
    public static func pages(fromIndex bytes: [UInt8], rootSlug: String) throws(SourceError) -> [Page] {
        guard let root = try? AemiJSON.parse(bytes).root, root.isObject else {
            throw .malformedPayload(url: url(forRoot: rootSlug), reason: "not a JSON object")
        }
        let slug = rootSlug.lowercased()
        var seen: Set<String> = []
        var pages: [Page] = []
        var stack: [JSON] = []
        root["interfaceLanguages"]
            .forEachMember { _, nodes in
                for node in (nodes.array ?? []).reversed() { stack.append(node) }
                while let node = stack.popLast() {
                    if let path = node["path"].string, node["external"].bool != true,
                        let key = key(forPath: path, rootSlug: slug), seen.insert(key).inserted
                    {
                        pages.append(Page(key: key, depth: max(0, key.split(separator: "/").count - 1)))
                    }
                    for child in (node["children"].array ?? []).reversed() { stack.append(child) }
                }
            }
        return pages
    }

    /// `path.replace(/^\/documentation\//i, '').toLowerCase()`, kept when it differs from the path (Bun's test) and
    /// lies in the root.
    private static func key(forPath path: String, rootSlug slug: String) -> String? {
        let prefix = "/documentation/"
        let stripped = path.prefix(prefix.count).lowercased() == prefix ? path.dropFirst(prefix.count) : Substring(path)
        let key = stripped.lowercased()
        guard key != path else { return nil }
        return key == slug || key.hasPrefix(slug + "/") ? key : nil
    }
}
