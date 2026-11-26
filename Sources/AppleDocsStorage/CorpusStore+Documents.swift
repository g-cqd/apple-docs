public import AppleDocsCore

extension CorpusStore {
    /// Inserts or updates a document record and returns its stable integer row ID in a single `RETURNING id` round-trip.
    @discardableResult
    public func upsertDocument(_ document: DocumentRecord) throws(SQLiteError) -> Int64 {
        guard
            let row = try connection.queryOne(
                "\(Self.upsertDocumentSQL) RETURNING id",
                bindings: Self.encodeDocumentBindings(document)
            )
        else {
            throw .transactionFailed("Failed to read row ID after upserting \(document.key.rawValue)")
        }
        return try row.integer(at: 0)
    }

    /// Replaces all sections for `documentID` (compressing bulky cells with Zstandard) and re-indexes its body
    /// in sync. Pass `document` when already in memory to skip re-SELECTing `title / abstract / declaration / headings`.
    public func replaceSections(
        forDocumentID documentID: Int64,
        sections: [DocumentSectionRecord],
        document: DocumentRecord? = nil
    ) throws(SQLiteError) {
        try connection.execute("DELETE FROM document_sections WHERE document_id = ?", bindings: [.integer(documentID)])
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
                    ZstdCodec.encodeSectionText(section.contentText),
                    ZstdCodec.encodeOptionalSectionText(section.contentJSON),
                    .integer(Int64(section.sortOrder))
                ]
            )
        }
        try indexBody(documentID: documentID, sections: sections, document: document)
    }

    /// Fetches a document record by its validated canonical ``DocumentKey``.
    public func document(forKey key: DocumentKey) throws(SQLiteError) -> DocumentRecord? {
        try documentWithID(forKey: key)?.document
    }

    /// Fetches `(id, document)` in a single `documents` lookup so callers can fetch `document_sections` by `document_id`.
    public func documentWithID(forKey key: DocumentKey) throws(SQLiteError) -> (id: Int64, document: DocumentRecord)? {
        guard
            let row = try connection.queryOne(
                "SELECT d.id, \(Self.documentColumnList) FROM documents d WHERE d.key = ?",
                bindings: [.text(key.rawValue)]
            )
        else { return nil }
        return (try row.integer(at: 0), try Self.decodeDocument(row, offset: 1))
    }

    /// Fetches all sections belonging to `documentID`, ordered by `sort_order`.
    public func sections(forDocumentID documentID: Int64) throws(SQLiteError) -> [DocumentSectionRecord] {
        let rows = try connection.query(
            "SELECT section_kind, heading, content_text, content_json, sort_order FROM document_sections WHERE document_id = ? ORDER BY sort_order, id",
            bindings: [.integer(documentID)]
        )
        return try rows.map(Self.decodeSection)
    }

    /// Fetches all sections belonging to the document identified by `key`, ordered by `sort_order`.
    public func sections(forKey key: DocumentKey) throws(SQLiteError) -> [DocumentSectionRecord] {
        let rows = try connection.query(
            "SELECT s.section_kind, s.heading, s.content_text, s.content_json, s.sort_order FROM document_sections s JOIN documents d ON d.id = s.document_id WHERE d.key = ? ORDER BY s.sort_order, s.id",
            bindings: [.text(key.rawValue)]
        )
        return try rows.map(Self.decodeSection)
    }

    private static let upsertDocumentSQL = """
        INSERT INTO documents (
            source_type, key, title, kind, role, role_heading, framework, url, language, usr,
            abstract_text, declaration_text, headings,
            min_ios, min_macos, min_watchos, min_tvos, min_visionos,
            min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
            is_deprecated, is_beta, is_release_notes, url_depth, source_metadata, content_hash, platforms_json
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?
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
            platforms_json = excluded.platforms_json,
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
            .optionalText(document.contentHash),
            .optionalText(document.platformsJSON)
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
        let cell = try row.value(at: column)
        do {
            return try ZstdCodec.decodeText(from: cell)
        } catch .typeMismatch {
            throw .typeMismatch(column: column, expected: "TEXT|BLOB?")
        }
    }

    /// Canonical column list (`source_type` .. `content_hash`) for decoding a ``DocumentRecord`` starting at offset `columnOffset`.
    public static let documentColumnList = """
        d.source_type, d.key, d.title, d.kind, d.role, d.role_heading, d.framework, d.url, d.language, d.usr,
        d.abstract_text, d.declaration_text, d.headings,
        d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
        d.is_deprecated, d.is_beta, d.is_release_notes, d.url_depth, d.source_metadata, d.content_hash,
        d.platforms_json
        """

    /// Number of columns in ``documentColumnList``.
    public static let documentColumnCount = 25

    /// Decodes a ``DocumentRecord`` from `row` whose columns match ``documentColumnList`` starting at `offset`.
    public static func decodeDocument(_ row: SQLiteRow, offset: Int = 0) throws(SQLiteError) -> DocumentRecord {
        let key = try decodeDocumentKey(row, column: offset + 1)
        let opt = try ((offset + 3) ... (offset + 24))
            .map { index throws(SQLiteError) -> SQLiteValue in
                try row.value(at: index)
            }
        return DocumentRecord(
            key: key,
            sourceType: SourceKind(rawValue: try row.text(at: offset)) ?? .appleDocC,
            title: try row.text(at: offset + 2),
            kind: opt[0].textValue,
            role: opt[1].textValue,
            roleHeading: opt[2].textValue,
            framework: try row.text(at: offset + 6),
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
            platformsJSON: opt[21].textValue,
            isDeprecated: (opt[15].integerValue ?? 0) != 0,
            isBeta: (opt[16].integerValue ?? 0) != 0,
            isReleaseNotes: (opt[17].integerValue ?? 0) != 0,
            urlDepth: Int(opt[18].integerValue ?? 0),
            sourceMetadataJSON: opt[19].textValue,
            contentHash: opt[20].textValue
        )
    }
}
