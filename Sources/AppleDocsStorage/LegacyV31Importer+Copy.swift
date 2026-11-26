extension LegacyV31Importer {
    static func copyCoreTables(on db: SQLiteConnection, available: Set<String>) throws(SQLiteError) {
        try executeAvailable(Self.coreCopySteps, available: available, on: db)
    }

    static func copyOptionalTables(
        on db: SQLiteConnection,
        available: Set<String>,
        includeRawPayloads: Bool
    ) throws(SQLiteError) {
        if includeRawPayloads {
            try executeAvailable(Self.rawCopySteps, available: available, on: db)
        }
        try executeAvailable(Self.vectorAndAssetCopySteps, available: available, on: db)
    }

    static func rebuildSearchIndexes(on db: SQLiteConnection, available: Set<String>) throws(SQLiteError) {
        try executeAvailable(Self.ftsCopySteps, available: available, on: db)
        if available.contains("documents_body_fts") { try copyBodyIndex(on: db) }
    }

    /// Bun's body index is contentless (its text cannot be read back): its FTS5 shadow tables are copied verbatim,
    /// giving identical postings and document lengths, hence identical bm25 scores. A content-bearing legacy index
    /// is re-inserted row by row instead.
    private static func copyBodyIndex(on db: SQLiteConnection) throws(SQLiteError) {
        let definition =
            try db.queryOne(
                "SELECT sql FROM legacy.sqlite_master WHERE name = 'documents_body_fts'"
            )?
            .optionalText(at: 0) ?? ""
        guard definition.contains("content=''"), definition.contains("contentless_delete=1") else {
            try db.executeScript(
                """
                DELETE FROM documents_body_fts;
                INSERT INTO documents_body_fts (rowid, body)
                SELECT rowid, body FROM legacy.documents_body_fts WHERE rowid IN (SELECT id FROM documents);
                """
            )
            return
        }
        do {
            try db.withShadowTableWrites {
                for shadow in ["data", "idx", "docsize", "config"] {
                    try db.executeScript(
                        """
                        DELETE FROM documents_body_fts_\(shadow);
                        INSERT INTO documents_body_fts_\(shadow) SELECT * FROM legacy.documents_body_fts_\(shadow);
                        """
                    )
                }
            }
        } catch let error as SQLiteError {
            throw error
        } catch {
            throw .closed
        }
    }

    private static func executeAvailable(
        _ steps: [(table: String, sql: String)],
        available: Set<String>,
        on db: SQLiteConnection
    ) throws(SQLiteError) {
        for step in steps where available.contains(step.table) {
            try db.executeScript(step.sql)
        }
    }

    private static let coreCopySteps: [(table: String, sql: String)] = [
        (
            "roots",
            """
            INSERT OR REPLACE INTO roots (
                slug, display_name, kind, source_type, seed_path, page_count, status, index_etag, last_seen
            )
            SELECT slug, display_name, kind, COALESCE(source_type, 'apple-docc'),
                   seed_path, page_count, status, index_etag, last_seen
            FROM legacy.roots;
            """
        ),
        (
            "documents",
            """
            INSERT OR REPLACE INTO documents (
                id, source_type, key, title, kind, role, role_heading, framework, url, language, usr,
                abstract_text, declaration_text, headings,
                min_ios, min_macos, min_watchos, min_tvos, min_visionos,
                min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
                is_deprecated, is_beta, is_release_notes, url_depth, source_metadata, content_hash,
                platforms_json
            )
            SELECT id, COALESCE(source_type, 'apple-docc'), lower(key), title, kind, role, role_heading,
                   COALESCE(framework, CASE
                       WHEN instr(key, '/') > 0 THEN substr(lower(key), 1, instr(key, '/') - 1)
                       ELSE lower(key)
                   END),
                   url, language, usr,
                   abstract_text, declaration_text, headings,
                   min_ios, min_macos, min_watchos, min_tvos, min_visionos,
                   min_ios_num, min_macos_num, min_watchos_num, min_tvos_num, min_visionos_num,
                   COALESCE(is_deprecated, 0), COALESCE(is_beta, 0), COALESCE(is_release_notes, 0),
                   COALESCE(url_depth, 0), source_metadata, content_hash, platforms_json
            FROM legacy.documents;
            """
        ),
        (
            // Bun's crawl membership (`pages`, active = crawled under that root) becomes `crawl_state`, which
            // drives root page counts and browse listings exactly like Bun's `pages` joins.
            "pages",
            """
            INSERT OR REPLACE INTO crawl_state (path, status, root_slug, depth, etag, last_modified)
            SELECT lower(p.path), CASE p.status WHEN 'active' THEN 'done' ELSE p.status END, r.slug,
                   COALESCE(p.url_depth, 0), p.etag, p.last_modified
            FROM legacy.pages p JOIN legacy.roots r ON r.id = p.root_id;
            -- Bun's last full per-page sweep: the next Swift sync keeps Bun's 7-day sweep schedule.
            INSERT OR REPLACE INTO sync_checkpoint (key, value)
            SELECT 'docc_full_sweep_at', value FROM legacy.schema_meta WHERE key = 'docc_full_sweep_at';
            """
        ),
        (
            "document_sections",
            """
            INSERT OR IGNORE INTO document_sections (
                id, document_id, section_kind, heading, content_text, content_json, sort_order
            )
            SELECT id, document_id, section_kind, heading, content_text, content_json, sort_order
            FROM legacy.document_sections
            WHERE document_id IN (SELECT id FROM documents);
            """
        ),
        (
            "document_relationships",
            """
            INSERT OR IGNORE INTO document_relationships (from_key, to_key, relation_type, section, sort_order)
            SELECT lower(from_key), lower(to_key), COALESCE(relation_type, 'reference'),
                   section, COALESCE(sort_order, 0)
            FROM legacy.document_relationships;
            """
        )
    ]

    private static let rawCopySteps: [(table: String, sql: String)] = [
        (
            "document_raw",
            """
            INSERT OR REPLACE INTO document_raw (document_id, raw)
            SELECT document_id, raw FROM legacy.document_raw
            WHERE document_id IN (SELECT id FROM documents);
            """
        )
    ]

    private static let vectorAndAssetCopySteps: [(table: String, sql: String)] = [
        (
            "document_vectors",
            """
            INSERT OR REPLACE INTO document_vectors (document_id, vec)
            SELECT document_id, vec FROM legacy.document_vectors
            WHERE document_id IN (SELECT id FROM documents);
            """
        ),
        (
            "document_chunks",
            """
            INSERT OR IGNORE INTO document_chunks (document_id, ord, text, vec_bin, vec_i8)
            SELECT document_id, ord, text, vec_bin, vec_i8 FROM legacy.document_chunks
            WHERE document_id IN (SELECT id FROM documents);
            """
        ),
        (
            "sf_symbols",
            """
            INSERT OR REPLACE INTO sf_symbols (
                name, scope, categories_json, keywords_json, aliases_json, availability_json,
                order_index, codepoint, bitmap_only, render_unsupported, unsupported_variants, bundle_version
            )
            SELECT name, scope, categories_json, keywords_json, aliases_json, availability_json,
                   order_index, codepoint, COALESCE(bitmap_only, 0),
                   COALESCE(render_unsupported, 0), unsupported_variants, bundle_version
            FROM legacy.sf_symbols;
            """
        ),
        (
            "apple_font_families",
            """
            INSERT OR REPLACE INTO apple_font_families (
                id, display_name, source_url, source_sha256, source_size, category, status
            )
            SELECT id, display_name, source_url, source_sha256, source_size, category, status
            FROM legacy.apple_font_families;
            """
        ),
        (
            "apple_font_files",
            """
            INSERT OR IGNORE INTO apple_font_files (
                id, family_id, file_name, file_path, postscript_name, style_name, weight,
                variant, italic, format, source, is_variable, axes_json, sha256, size
            )
            SELECT id, family_id, file_name, file_path, postscript_name, style_name, weight,
                   variant, COALESCE(italic, 0), format, COALESCE(source, 'remote'),
                   COALESCE(is_variable, 0), axes_json, sha256, size
            FROM legacy.apple_font_files
            WHERE family_id IN (SELECT id FROM apple_font_families);
            """
        )
    ]

    private static let ftsCopySteps: [(table: String, sql: String)] = [
        (
            "framework_synonyms",
            """
            INSERT OR REPLACE INTO framework_synonyms (canonical, alias)
            SELECT lower(canonical), lower(alias) FROM legacy.framework_synonyms;
            """
        ),
        (
            "sf_symbols_fts",
            """
            DELETE FROM sf_symbols_fts;
            INSERT INTO sf_symbols_fts (rowid, name, keywords, categories, aliases)
            SELECT s.rowid, f.name, f.keywords, f.categories, f.aliases
            FROM legacy.sf_symbols_fts f
            JOIN legacy.sf_symbols ls ON ls.rowid = f.rowid
            JOIN sf_symbols s ON s.scope = ls.scope AND s.name = ls.name;
            """
        )
    ]
}
