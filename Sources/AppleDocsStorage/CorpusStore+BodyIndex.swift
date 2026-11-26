import AppleDocsCore

/// The full-text body index (`documents_body_fts`), kept identical to Bun's: one contentless row per document whose
/// text is ``DocumentPlainText`` of the document fields and all its sections.
extension CorpusStore {
    /// Re-indexes one document's body from its in-memory `document` (when supplied) or stored fields + `sections`.
    func indexBody(
        documentID: Int64,
        sections: [DocumentSectionRecord],
        document: DocumentRecord? = nil
    ) throws(SQLiteError) {
        try connection.execute("DELETE FROM documents_body_fts WHERE rowid = ?", bindings: [.integer(documentID)])
        let body: String
        if let document {
            body = DocumentPlainText.render(
                title: document.title,
                abstract: document.abstractText,
                declaration: document.declarationText,
                headings: document.headings,
                sections: sections
            )
        } else {
            guard
                let row = try connection.queryOne(
                    "SELECT title, abstract_text, declaration_text, headings FROM documents WHERE id = ?",
                    bindings: [.integer(documentID)]
                )
            else { return }
            // @dl:accept -- column-to-argument mapping (same shape as the font-file decoder)
            body = DocumentPlainText.render(
                title: try row.optionalText(at: 0),
                abstract: try row.optionalText(at: 1),
                declaration: try row.optionalText(at: 2),
                headings: try row.optionalText(at: 3),
                sections: sections
            )
        }
        guard !body.isEmpty else { return }
        try connection.execute(
            "INSERT INTO documents_body_fts (rowid, body) VALUES (?, ?)",
            bindings: [.integer(documentID), .text(body)]
        )
    }

    /// Replaces a pre-contentless body index with Bun's definition and re-indexes every document.
    func migrateBodyIndexIfNeeded() throws(SQLiteError) {
        guard try CorpusSchemaV1.bodyIndexNeedsRebuild(on: connection) else { return }
        try connection.executeScript("BEGIN IMMEDIATE;")
        do {
            try connection.executeScript(
                """
                DROP TABLE documents_body_fts;
                CREATE VIRTUAL TABLE documents_body_fts USING fts5(
                    body, content='', contentless_delete=1, tokenize='porter unicode61'
                );
                """
            )
            for row in try connection.query("SELECT id, key FROM documents ORDER BY id") {
                let id = try row.integer(at: 0)
                let key = try? DocumentKey(try row.text(at: 1))
                let sections = try key.map { key throws(SQLiteError) in try self.sections(forKey: key) } ?? []
                try indexBody(documentID: id, sections: sections)
            }
            try connection.executeScript("COMMIT;")
        } catch {
            try? connection.executeScript("ROLLBACK;")
            throw error
        }
    }
}
