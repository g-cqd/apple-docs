public import AemiJSONCore
import AppleDocsCore
public import AppleDocsStorage
import Foundation
import OrderedCollections

/// Ports of Bun's MCP-facing command payloads (`commands/frameworks.js`, `taxonomy.js`, asset listings) as
/// ordered ``JSONValue`` envelopes, built from the same SQL so tool outputs match Bun's byte for byte.
public enum ToolPayloads {
    /// How one result column becomes an object member.
    enum Column {
        case text(String)
        case optionalText(String)
        case integer(String)
    }

    /// Runs `sql` and maps each row to an object whose members follow `columns` (in select-list order).
    static func objects(
        _ sql: String,
        bindings: [SQLiteValue] = [],
        columns: [Column],
        on connection: SQLiteConnection
    ) throws(SQLiteError) -> [JSONValue] {
        let rows = try connection.query(sql, bindings: bindings)
        var out: [JSONValue] = []
        out.reserveCapacity(rows.count)
        for row in rows {
            var object: OrderedDictionary<String, JSONValue> = [:]
            for (index, column) in columns.enumerated() {
                switch column {
                    case .text(let name): object[name] = .string(try row.text(at: index))
                    case .optionalText(let name): object[name] = DocCValue.optional(try row.optionalText(at: index))
                    case .integer(let name): object[name] = .int(try row.integer(at: index))
                }
            }
            out.append(.object(object))
        }
        return out
    }

    /// `frameworks({kind})`: roots with at least one crawled page (`crawl_state` = Bun `pages`), by slug.
    public static func frameworks(kind: String?, on connection: SQLiteConnection) throws(SQLiteError) -> JSONValue {
        let roots = try objects(
            """
            SELECT r.slug, r.display_name, r.kind, r.status, COALESCE(c.n, 0), r.last_seen
            FROM roots r
            LEFT JOIN (SELECT root_slug, COUNT(*) AS n FROM crawl_state WHERE status = 'done' GROUP BY root_slug) c
              ON c.root_slug = r.slug
            WHERE COALESCE(c.n, 0) > 0 AND (? IS NULL OR r.kind = ?)
            ORDER BY r.slug
            """,
            bindings: [.optionalText(kind), .optionalText(kind)],
            columns: [
                .text("slug"), .text("name"), .text("kind"), .text("status"), .integer("pageCount"),
                .optionalText("lastSeen")
            ],
            on: connection
        )
        return .object(["roots": .array(roots), "total": .int(Int64(roots.count))])
    }

    /// `taxonomy({field, all})`: value/count distributions (top 20 unless `all`).
    public static func taxonomy(field: String?, all: Bool, on connection: SQLiteConnection) throws(SQLiteError)
        -> JSONValue
    {
        let columns: OrderedDictionary<String, String> = [
            "kind": "kind", "role": "role", "docKind": "kind", "roleHeading": "role_heading",
            "sourceType": "source_type"
        ]
        func run(_ column: String) throws(SQLiteError) -> JSONValue {
            .array(
                try objects(
                    """
                    SELECT COALESCE(\(column), '') AS value, COUNT(*) AS count FROM documents
                    WHERE \(column) IS NOT NULL AND \(column) != '' GROUP BY \(column)
                    ORDER BY count DESC, value ASC\(all ? "" : " LIMIT 20")
                    """,
                    columns: [.text("value"), .integer("count")],
                    on: connection
                )
            )
        }
        let trimmed = field.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let trimmed, let column = columns[trimmed] {
            return .object(["field": .string(trimmed), "values": try run(column)])
        }
        var out: OrderedDictionary<String, JSONValue> = [:]
        for (name, column) in columns { out[name] = try run(column) }
        return .object(out)
    }

    /// `listAppleFonts`: families by display name, each with its files by file name.
    public static func appleFonts(on connection: SQLiteConnection) throws(SQLiteError) -> JSONValue {
        let files = try objects(
            "SELECT family_id, id, file_name FROM apple_font_files ORDER BY family_id, file_name",
            columns: [.text("family_id"), .text("id"), .text("file_name")],
            on: connection
        )
        var byFamily: [String: [JSONValue]] = [:]
        for file in files {
            guard case .object(var object) = file, case .string(let family)? = object["family_id"] else { continue }
            object.removeValue(forKey: "family_id")
            byFamily[family, default: []].append(.object(object))
        }
        let families = try objects(
            "SELECT id, display_name FROM apple_font_families ORDER BY display_name",
            columns: [.text("id"), .text("display_name")],
            on: connection
        )
        return .object([
            "families": .array(
                families.map { family in
                    guard case .object(var object) = family, case .string(let id)? = object["id"] else { return family }
                    object["files"] = .array(byFamily[id] ?? [])
                    return .object(object)
                }
            )
        ])
    }
}
