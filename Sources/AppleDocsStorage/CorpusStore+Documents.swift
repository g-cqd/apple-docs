public import AppleDocsCore

extension CorpusStore {
    /// Inserts or updates a document record and returns its stable integer row ID.
    @discardableResult
    public func upsertDocument(_ document: DocumentRecord) throws(SQLiteError) -> Int64 {
        try connection.execute(Self.upsertDocumentSQL, bindings: Self.encodeDocumentBindings(document))
        guard
            let row = try connection.queryOne(
                "SELECT id FROM documents WHERE key = ?",
                bindings: [.text(document.key.rawValue)]
            )
        else {
            throw .transactionFailed("Failed to read row ID after upserting \(document.key.rawValue)")
        }
        return try row.integer(at: 0)
    }

    /// Replaces all sections for `documentID` and updates `documents_body_fts` in sync.
    public func replaceSections(
        forDocumentID documentID: Int64,
        sections: [DocumentSectionRecord]
    ) throws(SQLiteError) {
        try connection.execute("DELETE FROM document_sections WHERE document_id = ?", bindings: [.integer(documentID)])
        try connection.execute("DELETE FROM documents_body_fts WHERE rowid = ?", bindings: [.integer(documentID)])
        var bodyParts: [String] = []
        bodyParts.reserveCapacity(sections.count)
        for section in sections {
            try connection.execute(
                """
                INSERT INTO document_sections (
                    document_id, section_kind, heading, content_text, content_json, sort_order
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                bindings: [
                    .integer(documentID),
                    .text(section.sectionKind),
                    .optionalText(section.heading),
                    .text(section.contentText),
                    .optionalText(section.contentJSON),
                    .integer(Int64(section.sortOrder))
                ]
            )
            if !section.contentText.isEmpty {
                bodyParts.append(section.contentText)
            }
        }
        if !bodyParts.isEmpty {
            try connection.execute(
                "INSERT INTO documents_body_fts (rowid, body) VALUES (?, ?)",
                bindings: [.integer(documentID), .text(bodyParts.joined(separator: "\n"))]
            )
        }
    }

    /// Fetches a document record by its validated canonical ``DocumentKey``.
    public func document(forKey key: DocumentKey) throws(SQLiteError) -> DocumentRecord? {
        guard
            let row = try connection.queryOne(
                "\(Self.documentSelectSQL) WHERE key = ?",
                bindings: [.text(key.rawValue)]
            )
        else {
            return nil
        }
        return try Self.decodeDocument(row)
    }

    /// Fetches all sections belonging to the document identified by `key`, ordered by `sort_order`.
    public func sections(forKey key: DocumentKey) throws(SQLiteError) -> [DocumentSectionRecord] {
        let rows = try connection.query(
            """
            SELECT s.section_kind, s.heading, s.content_text, s.content_json, s.sort_order
            FROM document_sections s
            JOIN documents d ON d.id = s.document_id
            WHERE d.key = ?
            ORDER BY s.sort_order, s.id
            """,
            bindings: [.text(key.rawValue)]
        )
        return try rows.map(Self.decodeSection)
    }

    private static let documentSelectSQL = """
        SELECT source_type, key, title, kind, role, role_heading, framework, url, language, usr,
               abstract_text, declaration_text, headings,
               min_ios, min_macos, min_watchos, min_tvos, min_visionos,
               is_deprecated, is_beta, is_release_notes, url_depth, source_metadata, content_hash
        FROM documents
        """

    private static let upsertDocumentSQL = """
        INSERT INTO documents (
            source_type, key, title, kind, role, role_heading, framework, url, language, usr,
            abstract_text, declaration_text, headings,
            min_ios, min_macos, min_watchos, min_tvos, min_visionos,
            min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
            is_deprecated, is_beta, is_release_notes, url_depth, source_metadata, content_hash
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(key) DO UPDATE SET
            source_type = excluded.source_type,
            title = excluded.title,
            kind = excluded.kind,
            role = excluded.role,
            role_heading = excluded.role_heading,
            framework = excluded.framework,
            url = excluded.url,
            language = excluded.language,
            usr = excluded.usr,
            abstract_text = excluded.abstract_text,
            declaration_text = excluded.declaration_text,
            headings = excluded.headings,
            min_ios = excluded.min_ios,
            min_macos = excluded.min_macos,
            min_watchos = excluded.min_watchos,
            min_tvos = excluded.min_tvos,
            min_visionos = excluded.min_visionos,
            min_ios_num = excluded.min_ios_num,
            min_macos_num = excluded.min_macos_num,
            min_watchos_num = excluded.min_watchos_num,
            min_tvos_num = excluded.min_tvos_num,
            min_visionos_num = excluded.min_visionos_num,
            is_deprecated = excluded.is_deprecated,
            is_beta = excluded.is_beta,
            is_release_notes = excluded.is_release_notes,
            url_depth = excluded.url_depth,
            source_metadata = excluded.source_metadata,
            content_hash = excluded.content_hash,
            updated_at = datetime('now')
        """

    private static func encodeDocumentBindings(_ document: DocumentRecord) -> [SQLiteValue] {
        let avail = document.availability
        let textFields: [String?] = [
            document.kind, document.role, document.roleHeading, document.url,
            document.language, document.usr, document.abstractText,
            document.declarationText, document.headings
        ]
        let platformStrings = [avail.ios, avail.macos, avail.watchos, avail.tvos, avail.visionos]
        let platformNumbers = [
            avail.iosNumeric, avail.macosNumeric, avail.watchosNumeric,
            avail.tvosNumeric, avail.visionosNumeric
        ]
        var bindings: [SQLiteValue] = [
            .text(document.sourceType.rawValue),
            .text(document.key.rawValue),
            .text(document.title)
        ]
        bindings.append(contentsOf: textFields[0 ..< 3].map(SQLiteValue.optionalText))
        bindings.append(.text(document.framework))
        bindings.append(contentsOf: textFields[3...].map(SQLiteValue.optionalText))
        bindings.append(contentsOf: platformStrings.map(SQLiteValue.optionalText))
        bindings.append(contentsOf: platformNumbers.map(SQLiteValue.optionalInteger))
        bindings.append(contentsOf: [
            .flag(document.isDeprecated),
            .flag(document.isBeta),
            .flag(document.isReleaseNotes),
            .integer(Int64(document.urlDepth)),
            .optionalText(document.sourceMetadataJSON),
            .optionalText(document.contentHash)
        ])
        return bindings
    }

    private static func decodeSection(_ row: SQLiteRow) throws(SQLiteError) -> DocumentSectionRecord {
        DocumentSectionRecord(
            sectionKind: try row.text(at: 0),
            heading: try row.optionalText(at: 1),
            contentText: try decodeTextOrUTF8Blob(row, column: 2) ?? "",
            contentJSON: try decodeTextOrUTF8Blob(row, column: 3),
            sortOrder: Int(try row.integer(at: 4))
        )
    }

    private static func decodeTextOrUTF8Blob(_ row: SQLiteRow, column: Int) throws(SQLiteError) -> String? {
        switch try row.value(at: column) {
            case .null: nil
            case .text(let string): string
            case .blob(let bytes): String(decoding: bytes, as: UTF8.self)
            default: throw .typeMismatch(column: column, expected: "TEXT|BLOB?")
        }
    }

    private static func decodeDocument(_ row: SQLiteRow) throws(SQLiteError) -> DocumentRecord {
        let key = try decodeDocumentKey(row, column: 1)
        let opt = try (3 ... 23).map { index throws(SQLiteError) -> SQLiteValue in try row.value(at: index) }
        return DocumentRecord(
            key: key,
            sourceType: SourceKind(rawValue: try row.text(at: 0)) ?? .appleDocC,
            title: try row.text(at: 2),
            kind: opt[0].textValue,
            role: opt[1].textValue,
            roleHeading: opt[2].textValue,
            framework: try row.text(at: 6),
            url: opt[4].textValue,
            language: opt[5].textValue,
            usr: opt[6].textValue,
            abstractText: opt[7].textValue,
            declarationText: opt[8].textValue,
            headings: opt[9].textValue,
            availability: PlatformAvailability(
                ios: opt[10].textValue,
                macos: opt[11].textValue,
                watchos: opt[12].textValue,
                tvos: opt[13].textValue,
                visionos: opt[14].textValue
            ),
            isDeprecated: (opt[15].integerValue ?? 0) != 0,
            isBeta: (opt[16].integerValue ?? 0) != 0,
            isReleaseNotes: (opt[17].integerValue ?? 0) != 0,
            urlDepth: Int(opt[18].integerValue ?? 0),
            sourceMetadataJSON: opt[19].textValue,
            contentHash: opt[20].textValue
        )
    }
}
