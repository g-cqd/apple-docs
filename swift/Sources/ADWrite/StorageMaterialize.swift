// `storage materialize` — the native port of `storageMaterialize`
// (src/commands/storage.js): force-materialize rendered files for all (or a
// root-filtered subset of) documents.
//
//   • `raw-json` — decompress the raw upstream payloads shipped in the DB
//     (`document_raw`, the zstd-or-plain section codec) to loose
//     `<dataDir>/raw-json/<key>.json` files.
//   • `markdown` / `html` — render every selected document from its
//     `document_sections` rows to `<dataDir>/markdown/<key>.md` /
//     `<dataDir>/html/<key>.html`. The renderers are the SAME in-process
//     engines the JS routes through (`DocMarkdown` — the JS
//     `nativeDocMarkdownBatch` FFI target — and `DocContentRenderer`, the
//     render-html.js port), so the bytes match the JS output. The JS's
//     batch-then-pool split is a Bun↔FFI transport artifact; one sequential
//     loop renders the identical files.
//
// One deliberate divergence: section content cells are decoded through
// `SectionCodec` before rendering, so materialize works on a compacted corpus.
// The JS reads the raw rows and would crash on zstd BLOBs (its own section-codec
// contract — "every section reader decodes" — which storage.js forgot); the
// compact profile's install flow depends on materialize working post-compact.

import ADContent
public import ADStorage

/// The materialize verb over a writable, migrated corpus.
public enum StorageMaterialize {
    /// The output format (`--format`; anything unrecognized fell back to
    /// markdown in the CLI dispatch, mirroring maintenance.js).
    public enum Format: String, Sendable {
        case markdown
        case html
        case rawJson = "raw-json"
    }

    /// The JS result object, one case per return-shape branch (each branch
    /// pins its own key order for `--json`).
    public enum Result: Sendable, Equatable {
        /// `{ format: 'raw-json', materialized }` — also the "no document_raw
        /// table" early return (materialized 0).
        case rawJson(materialized: Int)
        /// `{ format, materialized: 0, total }` — no document_sections (lite tier).
        case noSections(format: Format, total: Int)
        /// `{ materialized, format }` — the rendered markdown/html leg.
        case rendered(materialized: Int, format: Format)
    }

    /// Run materialize. `roots` filters to documents whose ACTIVE page belongs
    /// to one of the named root slugs (empty → every document).
    public static func run(
        _ db: SQLiteWriteConnection, dataDir: String, format: Format, roots: [String] = [],
        log: ((String) -> Void)? = nil, logError: ((String) -> Void)? = nil
    ) throws -> Result {
        if format == .rawJson {
            return try materializeRawJson(db, dataDir: dataDir, log: log, logError: logError)
        }
        return try renderDocuments(db, dataDir: dataDir, format: format, roots: roots, log: log, logError: logError)
    }

    // MARK: - raw-json

    private static func materializeRawJson(
        _ db: SQLiteWriteConnection, dataDir: String,
        log: ((String) -> Void)?, logError: ((String) -> Void)?
    ) throws -> Result {
        guard try db.hasTable("document_raw") else {
            log?("No document_raw to materialize (raw payloads not shipped in this snapshot).")
            return .rawJson(materialized: 0)
        }
        let rows = try db.all(
            "SELECT dr.document_id AS id, d.key AS key FROM document_raw dr JOIN documents d ON d.id = dr.document_id")
        var materialized = 0
        for row in rows {
            guard let id = row.int("id"), let key = row.text("key") else { continue }
            guard
                let blob = try db.get(
                    "SELECT raw FROM document_raw WHERE document_id = $id", ["id": .integer(id)])
            else { continue }
            do {
                guard let path = keyPath(dataDir: dataDir, subdir: "raw-json", key: key, ext: ".json") else {
                    throw MaintenanceError("invalid storage key")
                }
                try writeText(SectionCodec.decodeText(blob["raw"]) ?? "", to: path)
                materialized += 1
            } catch {
                logError?("raw-json materialize failed for \(key): \(error)")
            }
        }
        log?("Materialized \(materialized) raw-json files.")
        return .rawJson(materialized: materialized)
    }

    // MARK: - markdown / html

    private static func renderDocuments(
        _ db: SQLiteWriteConnection, dataDir: String, format: Format, roots: [String],
        log: ((String) -> Void)?, logError: ((String) -> Void)?
    ) throws -> Result {
        let docsRows = try selectDocuments(db, roots: roots)

        guard try db.hasTable("document_sections") else {
            log?("document_sections table not available (lite tier) — cannot materialize")
            return .noSections(format: format, total: docsRows.count)
        }

        var materialized = 0
        for doc in docsRows {
            guard let id = doc.int("id"), let key = doc.text("key") else { continue }
            let sections = try sectionRows(db, documentId: id)
            let content: String
            let outPath: String?
            if format == .html {
                content = DocContentRenderer.render(title: doc.text("title"), sections: sections.map(htmlSection))
                outPath = keyPath(dataDir: dataDir, subdir: "html", key: key, ext: ".html")
            } else {
                content = DocMarkdown.render(document: markdownDocument(doc), sections: sections.map(markdownSection))
                outPath = keyPath(dataDir: dataDir, subdir: "markdown", key: key, ext: ".md")
            }
            do {
                guard let outPath else { throw MaintenanceError("invalid storage key") }
                try writeText(content, to: outPath)
                materialized += 1
            } catch {
                logError?("Failed to write \(outPath ?? key): \(error)")
            }
        }
        return .rendered(materialized: materialized, format: format)
    }

    /// The JS docs query, verbatim column list: root-filtered (JOIN pages ON
    /// p.path = d.key, active only) or every document, both `ORDER BY key`.
    private static func selectDocuments(
        _ db: SQLiteWriteConnection, roots: [String]
    ) throws(SQLiteWriteError) -> [SQLiteRow] {
        guard !roots.isEmpty else {
            return try db.all(
                """
                SELECT id, key, title, kind, role, role_heading, framework, abstract_text, declaration_text, source_type
                   FROM documents
                   ORDER BY key
                """)
        }
        let list = inList(roots.map(SQLiteValue.text))
        return try db.all(
            """
            SELECT d.id, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.abstract_text, d.declaration_text, d.source_type
               FROM documents d
               JOIN pages p ON p.path = d.key
               JOIN roots r ON p.root_id = r.id
               WHERE r.slug IN (\(list.marks)) AND p.status = 'active'
               ORDER BY d.key
            """,
            list.params)
    }

    /// One document's sections (`ORDER BY sort_order, id`), content cells
    /// decoded through the section codec (see the header divergence note).
    private static func sectionRows(
        _ db: SQLiteWriteConnection, documentId: Int64
    ) throws(SQLiteWriteError) -> [SectionRow] {
        let rows = try db.all(
            """
            SELECT section_kind, heading, content_text, content_json, sort_order
             FROM document_sections
             WHERE document_id = $id
             ORDER BY sort_order, id
            """,
            ["id": .integer(documentId)])
        return rows.map { row in
            SectionRow(
                sectionKind: row.text("section_kind"), heading: row.text("heading"),
                contentText: SectionCodec.decodeText(row["content_text"]),
                contentJSON: SectionCodec.decodeText(row["content_json"]),
                sortOrder: numeric(row["sort_order"]))
        }
    }

    private struct SectionRow {
        let sectionKind: String?
        let heading: String?
        let contentText: String?
        let contentJSON: String?
        let sortOrder: Double
    }

    /// The materialize doc row → the markdown renderer's document shape. The
    /// JS row has no frameworkDisplay/platformsJson keys, so both pack null
    /// (front matter falls back to the raw `framework` and drops platforms).
    private static func markdownDocument(_ doc: SQLiteRow) -> DocMarkdownDocument {
        DocMarkdownDocument(
            key: doc.text("key"), title: doc.text("title"), framework: doc.text("framework"),
            frameworkDisplay: nil, role: doc.text("role"), roleHeading: doc.text("role_heading"),
            platformsJSON: nil)
    }

    /// coerceSection (render-markdown.js): contentText `?? ''`.
    private static func markdownSection(_ section: SectionRow) -> DocMarkdownSection {
        DocMarkdownSection(
            kind: section.sectionKind, heading: section.heading,
            contentText: section.contentText ?? "", contentJSON: section.contentJSON,
            sortOrder: section.sortOrder)
    }

    /// coerceSection (render-html/helpers.js): the html renderer's row shape.
    private static func htmlSection(_ section: SectionRow) -> DocSection {
        DocSection(
            sectionKind: section.sectionKind, heading: section.heading,
            contentText: section.contentText, contentJson: section.contentJSON,
            sortOrder: section.sortOrder)
    }

    /// `sort_order` as a Double whether the cell is INTEGER or REAL.
    private static func numeric(_ value: SQLiteValue?) -> Double {
        switch value {
            case .integer(let int): return Double(int)
            case .real(let double): return double
            default: return 0
        }
    }
}
