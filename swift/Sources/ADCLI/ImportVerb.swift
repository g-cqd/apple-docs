// `ad-cli import <sqlite> --db <ADDB>` — build a fresh ADDB apple-docs corpus by importing an existing
// SQLite corpus LOCALLY (no network crawl). Wraps ADDBImport's `Database.importSQLite`, which auto-copies
// every regular table (+ its indexes) and reconstructs the FTS5 tables / build-time denorm columns named in
// the manifest below. This is the guaranteed-fast path for standing the native corpus up from scratch.

import ADDB
import ADDBImport
import ADDBJSON  // registers JSON_EXTRACT so the year_num / track_lc denorm folds resolve during import
import ArgumentParser
import Foundation

/// The apple-docs SQLite→ADDB import manifest. FTS5 tokenize/config isn't introspectable from a `.db`, and
/// ADSQL has no `ALTER TABLE`, so the importer needs this explicit description of (a) the FTS tables to
/// rebuild and where their indexed text is read from, (b) the build-time denorm columns to create + populate
/// (matching `ADSQLSearch.SearchDenorm`), and (c) the heavy, regenerable tables to skip. Everything else
/// (documents, pages, document_sections, document_relationships, roots, sf_symbols, fonts, …) is auto-copied.
enum AppleDocsImportManifest {
    static let value = ImportManifest(
        ftsTables: [
            // Primary search index — title/abstract/declaration/headings/key (porter). Self-contained; the
            // FTS `abstract`/`declaration` columns read documents' `abstract_text`/`declaration_text`.
            ImportManifest.FTSTable(
                name: "documents_fts",
                columns: ["title", "abstract", "declaration", "headings", "key"],
                tokenize: ["porter", "unicode61"],
                content: .selfContained,
                source: ImportManifest.Source(
                    table: "documents",
                    columns: ["title", "abstract_text", "declaration_text", "headings", "key"])),
            // Fuzzy title (trigram, case-insensitive) — external-content over documents.
            ImportManifest.FTSTable(
                name: "documents_trigram",
                columns: ["title"],
                tokenize: ["trigram", "case_sensitive", "0"],
                content: .external(table: "documents", rowid: "id"),
                source: ImportManifest.Source(table: "documents", columns: ["title"])),
            // Full-body FTS (porter). The body text isn't a `documents` column — it lives in this
            // self-contained FTS's own `_content` shadow (column `c0`), so we source it from there.
            ImportManifest.FTSTable(
                name: "documents_body_fts",
                columns: ["body"],
                tokenize: ["porter", "unicode61"],
                content: .selfContained,
                source: ImportManifest.Source(table: "documents_body_fts_content", columns: ["c0"])),
            // SF Symbol search — name/keywords/categories/aliases (porter), from sf_symbols' `*_json` columns.
            ImportManifest.FTSTable(
                name: "sf_symbols_fts",
                columns: ["name", "keywords", "categories", "aliases"],
                tokenize: ["porter", "unicode61"],
                content: .selfContained,
                source: ImportManifest.Source(
                    table: "sf_symbols",
                    columns: ["name", "keywords_json", "categories_json", "aliases_json"]))
        ],
        // The search/read serve doesn't need these: the embedding/chunk vectors (rebuilt by `ad-cli index`),
        // the empty raw-payload + symbol-render stores, and the web-render cache.
        skipTables: [
            "document_vectors", "document_chunks", "document_raw",
            "sf_symbol_renders", "document_render_index"
        ],
        denorm: [
            ImportManifest.Denorm(
                table: "documents",
                columns: [
                    ImportManifest.Denorm.Column(name: "title_lc", type: .text, valueSQL: "LOWER(title)"),
                    ImportManifest.Denorm.Column(name: "key_lc", type: .text, valueSQL: "LOWER(key)"),
                    ImportManifest.Denorm.Column(
                        name: "year_num", type: .integer,
                        valueSQL: "CAST(json_extract(source_metadata, '$.year') AS INTEGER)"),
                    ImportManifest.Denorm.Column(
                        name: "track_lc", type: .text,
                        valueSQL: "LOWER(COALESCE(json_extract(source_metadata, '$.track'), ''))")
                ],
                lookups: [
                    // root_display / root_slug ← the roots row whose `slug` == documents.`framework`, else
                    // the framework itself (COALESCE(r.display_name/r.slug, d.framework)).
                    ImportManifest.Denorm.Lookup(
                        name: "root_display", type: .text, matchColumn: "framework",
                        lookupTable: "roots", lookupKey: "slug", lookupValue: "display_name",
                        fallbackColumn: "framework"),
                    ImportManifest.Denorm.Lookup(
                        name: "root_slug", type: .text, matchColumn: "framework",
                        lookupTable: "roots", lookupKey: "slug", lookupValue: "slug",
                        fallbackColumn: "framework")
                ])
        ])
}

/// `ad-cli import <sqlite> --db <ADDB>` — the local corpus-build verb.
struct ImportCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "import",
        abstract: "Build a fresh ADDB corpus from a SQLite apple-docs corpus (local; no network crawl).")

    @Argument(help: "Path to the source SQLite .db.")
    var sqlite: String

    @Option(name: .long, help: "Path to the ADDB corpus to create (must not already exist / be non-empty).")
    var db: String

    @Flag(name: .long, help: "Emit the integrity report as JSON.")
    var json = false

    func run() throws {
        // Fresh, unmigrated target: importSQLite recreates every table from the SQLite schema and REFUSES a
        // non-empty target, so — unlike the crawl verbs — we deliberately do NOT migrate the apple-docs schema.
        let database: Database
        do {
            database = try Database.open(
                at: db, options: DatabaseOptions(readOnly: false, createIfMissing: true))
        } catch {
            FileHandle.standardError.write(Data("ad-cli: cannot create \(db): \(error)\n".utf8))
            throw ExitCode(1)
        }
        // Register JSON_EXTRACT before the import so the manifest's year_num / track_lc denorm UPDATEs
        // (which fold source_metadata JSON) resolve — the serve does the same in backfillSearchDenorm.
        database.enableJSON()
        let report: IntegrityReport
        do {
            report = try database.importSQLite(from: sqlite, manifest: AppleDocsImportManifest.value)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: import failed: \(error)\n".utf8))
            throw ExitCode(1)
        }
        if json {
            print(
                "{\"tables\":\(report.tableCount),\"indexes\":\(report.indexCount),"
                    + "\"pages\":\(report.pageCount),\"kv\":\(report.kvCount)}")
        } else {
            print(
                "imported: tables=\(report.tableCount) indexes=\(report.indexCount) "
                    + "pages=\(report.pageCount) kv=\(report.kvCount)")
        }
    }
}
