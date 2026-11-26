public import AemiJSONCore
import AppleDocsCore
import AppleDocsSearch
public import AppleDocsStorage
import OrderedCollections

/// Port of Bun's `commands/browse.js`.
extension ToolPayloads {
    /// Browse arguments.
    public struct BrowseRequest: Sendable {
        public var framework: String?
        public var path: String?
        public var year: Int?
        public var limit: Int?
        public var defaultLimit: Int?

        public init(
            framework: String?,
            path: String? = nil,
            year: Int? = nil,
            limit: Int? = nil,
            defaultLimit: Int? = 100
        ) {
            self.framework = framework
            self.path = path
            self.year = year
            self.limit = limit
            self.defaultLimit = defaultLimit
        }
    }

    private typealias Root = CorpusRootResolver.Root

    public static func browse(_ request: BrowseRequest, on connection: SQLiteConnection) throws -> JSONValue {
        guard let framework = request.framework, !framework.isEmpty else {
            throw ToolPayloadError("framework is required")
        }
        guard let root = try CorpusRootResolver.resolve(framework, on: connection) else {
            throw ToolPayloadError("Unknown framework: \(framework)")
        }
        let isWWDC = root.sourceType == "wwdc"
        if request.year != nil, !isWWDC { throw ToolPayloadError("year only applies to the wwdc root") }
        if let path = request.path { return try children(of: path, root: root, on: connection) }

        let limit = request.limit.map { max($0, 1) } ?? request.defaultLimit
        // Non-WWDC roots only need the first `limit` pages and a count; WWDC groups and year filters need all.
        var pages = try pagesByRoot(root.slug, limit: isWWDC ? nil : limit, on: connection)
        let total = isWWDC || limit == nil ? pages.count : try pageCount(root.slug, on: connection)
        if isWWDC, let year = request.year {
            pages = pages.filter { $0.path.hasPrefix("wwdc/wwdc\(year)-") }
            if pages.isEmpty { throw ToolPayloadError("No WWDC sessions indexed for \(year)") }
        } else if isWWDC, request.limit == nil {
            return wwdcGroups(pages, root: root)
        }
        let shown = limit.map { Array(pages.prefix($0)) } ?? pages
        let matching = isWWDC ? pages.count : total
        var out: OrderedDictionary<String, JSONValue> = [
            "framework": .string(root.displayName), "slug": .string(root.slug), "kind": .string(root.kind)
        ]
        if let year = request.year { out["year"] = .int(Int64(year)) }
        out["pages"] = .array(shown.map(\.summary))
        out["total"] = .int(Int64(matching))
        out["limited"] = .bool(limit.map { $0 < matching } ?? false)
        return .object(out)
    }

    private static func children(of path: String, root: Root, on connection: SQLiteConnection) throws -> JSONValue {
        guard let page = try connection.queryOne("SELECT title FROM documents WHERE key = ?", bindings: [.text(path)])
        else { throw ToolPayloadError("Page not found: \(path)") }
        let children = try objects(
            """
            SELECT dr.to_key, COALESCE(td.title, dr.to_key), COALESCE(dr.section, dr.relation_type)
            FROM document_relationships dr LEFT JOIN documents td ON td.key = dr.to_key
            WHERE dr.from_key = ? ORDER BY dr.sort_order, dr.to_key
            """,
            bindings: [.text(path)],
            columns: [.text("path"), .text("title"), .optionalText("section")],
            on: connection
        )
        return .object([
            "framework": .string(root.displayName), "path": .string(path), "title": .string(try page.text(at: 0)),
            "children": .array(children)
        ])
    }

    private struct PageRow {
        let path: String
        let summary: JSONValue
    }

    /// `getPagesByRoot`: crawled pages of a root by key, each as Bun's browse page object.
    private static func pagesByRoot(
        _ slug: String,
        limit: Int?,
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [PageRow] {
        try objects(
            """
            SELECT d.key, d.title, COALESCE(d.role_heading, d.role), d.abstract_text
            FROM documents d JOIN crawl_state c ON c.path = d.key
            WHERE c.root_slug = ? AND c.status = 'done' ORDER BY c.path LIMIT ?
            """,
            bindings: [.text(slug), .integer(Int64(limit ?? -1))],
            columns: [.text("path"), .text("title"), .optionalText("kind"), .optionalText("abstract")],
            on: connection
        )
        .map { page in
            let path: String =
                if case .object(let object) = page, case .string(let key)? = object["path"] { key } else { "" }
            return PageRow(path: path, summary: page)
        }
    }

    private static func pageCount(_ slug: String, on connection: SQLiteConnection) throws(SQLiteError) -> Int {
        let row = try connection.queryOne(
            "SELECT COUNT(*) FROM documents d JOIN crawl_state c ON c.path = d.key WHERE c.root_slug = ? AND c.status = 'done'",
            bindings: [.text(slug)]
        )
        return Int(try row?.integer(at: 0) ?? 0)
    }

    private static func wwdcGroups(_ pages: [PageRow], root: Root) -> JSONValue {
        var counts: [Int: Int] = [:]
        for page in pages where page.path.hasPrefix("wwdc/wwdc") {
            let digits = page.path.dropFirst("wwdc/wwdc".count).prefix(5)
            guard digits.count == 5, digits.last == "-", let year = Int(digits.prefix(4)) else { continue }
            counts[year, default: 0] += 1
        }
        let groups: [JSONValue] = counts.sorted { $0.key > $1.key }
            .map { year, count in
                .object(["year": .int(Int64(year)), "count": .int(Int64(count))])
            }
        return .object([
            "framework": .string(root.displayName), "slug": .string(root.slug), "kind": .string(root.kind),
            "groups": .array(groups), "total": .int(Int64(pages.count))
        ])
    }
}
