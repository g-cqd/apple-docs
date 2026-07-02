// The apple-docs CRAWL-PERSIST PARITY gate — the deliverable's proof.
//
// The JS writer emits SQLite; the native ADWrite persist emits ADDB ("ADSQLv0").
// They are not byte-comparable, so the gate bridges via ADDB's OWN importer (the
// "apple-docs swap gate", ADSQLImport) and compares ADDB-to-ADDB:
//
//   1. FIXTURE (deterministic, real data): a `bun` script reads a handful of real
//      apple-docs documents from the test corpus, reconstructs each as the exact
//      JS `normalize()` object, and emits BOTH (a) normalized.json (the native
//      input) AND (b) reference.sqlite (a fresh DB written by the JS writer's
//      upsertRoot + the persist.js `db.tx` body over those same objects).
//   2. NATIVE: fresh ADDB → migrateSchema → decode normalized.json →
//      CrawlPersist.upsertRoot + persistNormalized → DB_native.
//   3. REFERENCE: fresh ADDB → importSQLite(from: reference.sqlite) → DB_ref.
//   4. COMPARE: for each user table (roots, pages, documents, document_sections,
//      document_relationships) read all rows via the ADDB engine and compare as an
//      ORDER-INDEPENDENT multiset of canonical row keys, EXCLUDING wall-clock
//      columns (first_seen, last_seen, downloaded_at, converted_at, created_at,
//      updated_at) and surrogate autoincrement ids (compared by logical key
//      instead). FTS/shadow tables are derived (trigger-maintained) and excluded.
//
// A full multiset match across all five tables is the proof the native persist
// writes the SAME rows as the Bun `bun:sqlite` writer.

import ADDB
import ADDBImport
import ADDBMigrate
import ADSQLModel
import Foundation
import Testing

@testable import ADWrite

@Suite("apple-docs crawl-persist parity (native ADDB vs JS SQLite via ADSQLImport)")
struct CrawlPersistParityTests {
    @Test(
        "native persist rows match the JS-writer SQLite imported into ADDB",
        .enabled(if: FixtureBuilder.corpusAvailable))
    func nativePersistMatchesImportedReference() throws {
        // ── Build the deterministic fixture from the real corpus ─────────────
        let fixture = try FixtureBuilder.build()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        // Decode the native input (the JS normalize() objects).
        let recordsData = try Data(contentsOf: fixture.normalizedJSON)
        let records = try JSONDecoder().decode([FixtureRecord].self, from: recordsData)
        #expect(!records.isEmpty)

        // ── DB_native: migrate + run the native persist over the fixture ─────
        let nativeURL = fixture.directory.appendingPathComponent("native.adsql")
        let dbNative = try Database.open(at: nativeURL.path, options: DatabaseOptions())
        defer { dbNative.close() }
        try migrateSchema(dbNative)

        // A FIXED ISO timestamp for the wall-clock columns — they are excluded from
        // the comparison, but a constant keeps the native write fully deterministic.
        let now = "2026-06-20T00:00:00.000Z"
        for record in records {
            let rootId = try CrawlPersist.upsertRoot(
                dbNative,
                slug: record.root.slug,
                displayName: record.root.displayName,
                kind: record.root.kind,
                source: record.root.source,
                seedPath: record.root.seedPath,
                sourceType: record.root.sourceType,
                now: now)
            try CrawlPersist.persistNormalized(
                dbNative,
                rootId: rootId,
                path: record.path,
                record.normalized,
                hashes: .init(content: record.contentHash, rawPayload: record.rawPayloadHash),
                now: now)
        }

        // ── DB_ref: import the JS-writer SQLite into a fresh ADDB DB ──────────
        let refURL = fixture.directory.appendingPathComponent("ref.adsql")
        let dbRef = try Database.open(at: refURL.path, options: DatabaseOptions())
        defer { dbRef.close() }
        // Skip every non-compared table (FTS bases are auto-skipped as virtual; their
        // shadow tables are regular tables, so list them explicitly along with the
        // other tables the persist never writes). We compare only the five user
        // tables, so DB_ref needs only those imported.
        let manifest = ImportManifest(skipTables: ReferenceImport.skipTables)
        _ = try dbRef.importSQLite(from: fixture.referenceSQLite.path, manifest: manifest)

        // ── Compare the five user tables as row multisets ────────────────────
        var report = PersistDiff.Report()
        for table in ComparedTable.allCases {
            let nativeRows = try RowReader.canonicalRows(dbNative, table: table)
            let refRows = try RowReader.canonicalRows(dbRef, table: table)
            report.add(table: table.rawValue, native: nativeRows, reference: refRows)
        }

        print(report.render())
        #expect(report.isMatch, "crawl-persist parity mismatch — see the printed diff above")
    }
}

// MARK: - Fixture decoding model (mirrors make-fixture.js record shape)

/// One fixture record: the root upsert args, the persist path/meta, and the
/// normalized document. Decoded from `normalized.json`.
private struct FixtureRecord: Decodable {
    struct Root: Decodable {
        var slug: String
        var displayName: String
        var kind: String
        var source: String
        var seedPath: String?
        var sourceType: String?
    }
    var root: Root
    var path: String
    var sourceType: String?
    var contentHash: String
    var rawPayloadHash: String
    var normalized: NormalizedDoc
}

// MARK: - The five compared tables + their wall-clock exclusions

/// The user tables the persist writes; the snapshot/embeddings tables and the FTS
/// shadow tables are out of scope for this slice and excluded.
enum ComparedTable: String, CaseIterable {
    case roots
    case pages
    case documents
    case documentSections = "document_sections"
    case documentRelationships = "document_relationships"

    /// The stable logical key for ORDER BY (so the read order is deterministic; the
    /// comparison is multiset-based, but a stable order makes the diff readable).
    var orderBy: String {
        switch self {
            case .roots: return "slug"
            case .pages: return "path"
            case .documents: return "key"
            case .documentSections: return "document_id, section_kind, sort_order"
            case .documentRelationships: return "from_key, to_key, relation_type"
        }
    }

    /// Columns EXCLUDED from the row key: wall-clock timestamps (set from a live
    /// clock by the JS writer, a fixed constant by the native one) and surrogate
    /// autoincrement ids (`id` here is a rowid alias whose VALUE is allocation-order
    /// dependent — the logical identity is the natural key, which the other columns
    /// carry). `page_count` on roots is excluded too: the JS `upsertRoot` never sets
    /// it (it stays the DEFAULT 0 and is maintained by a separate updateRootPageCount
    /// pass the persist does not run), so both sides hold 0 — but excluding it keeps
    /// the gate robust to that maintenance pass.
    var excludedColumns: Set<String> {
        switch self {
            case .roots:
                return ["id", "first_seen", "last_seen"]
            case .pages:
                return ["id", "root_id", "downloaded_at", "converted_at"]
            case .documents:
                // id + wall-clock, plus the v28 apple-docs-native search-denorm columns: they have no
                // JS-writer equivalent, so the imported reference always holds NULL there. They are
                // populated by the native writer / the post-import backfill (the 5A serving path), not
                // compared against the JS catalog here — excluded so the row-multiset parity stays a
                // statement about the columns the JS writer actually produces.
                return [
                    "id", "created_at", "updated_at",
                    "title_lc", "key_lc", "year_num", "track_lc", "root_display", "root_slug"
                ]
            case .documentSections:
                // document_id is a surrogate FK (allocation-order dependent); the
                // section's logical identity is (its document's key via the row order)
                // + section_kind + sort_order + content. We drop the numeric ids and
                // compare the content tuple. To keep sections of DIFFERENT documents
                // distinct, the reader prefixes each section row with its parent key.
                return ["id", "document_id"]
            case .documentRelationships:
                return ["id"]
        }
    }
}

// MARK: - Reading rows as canonical, comparable keys

enum RowReader {
    /// Reads every row of `table` from `db` and renders each as a canonical string
    /// key over the NON-excluded columns (sorted by column name for a stable,
    /// engine-independent encoding). For document_sections, each row is prefixed
    /// with its parent document's `key` (resolved via a join) so sections of
    /// different documents never collide and surrogate document_id is irrelevant.
    static func canonicalRows(_ db: Database, table: ComparedTable) throws -> [String] {
        switch table {
            case .documentSections:
                return try sectionRows(db)
            default:
                let excluded = table.excludedColumns
                let rows =
                    try db.prepare(
                        "SELECT * FROM \(table.rawValue) ORDER BY \(table.orderBy)"
                    )
                    .all()
                return rows.map { canonicalKey($0, excluding: excluded) }
        }
    }

    /// document_sections joined to documents.key so the surrogate document_id is
    /// replaced by the stable document key in the comparison.
    private static func sectionRows(_ db: Database) throws -> [String] {
        let rows =
            try db.prepare(
                """
                SELECT d.key AS doc_key, s.section_kind, s.heading, s.content_text,
                       s.content_json, s.sort_order
                FROM document_sections s
                JOIN documents d ON d.id = s.document_id
                ORDER BY d.key, s.section_kind, s.sort_order
                """
            )
            .all()
        // All selected columns are part of the key (no exclusions in this projection).
        return rows.map { canonicalKey($0, excluding: []) }
    }

    /// Render a row to a stable string over its non-excluded columns, sorted by
    /// column name so the encoding does not depend on SELECT column order.
    private static func canonicalKey(_ row: SQLRow, excluding excluded: Set<String>) -> String {
        let names = row.columns
        var pairs: [(String, String)] = []
        pairs.reserveCapacity(names.count)
        for name in names where !excluded.contains(name.lowercased()) {
            pairs.append((name.lowercased(), render(row[name])))
        }
        pairs.sort { $0.0 < $1.0 }
        return pairs.map { "\($0.0)=\($0.1)" }.joined(separator: "\u{1F}")  // unit separator
    }

    /// Canonical cell rendering with an explicit type tag so a numeric and a string
    /// holding the same digits never compare equal (strict typing made visible).
    private static func render(_ value: Value?) -> String {
        switch value {
            case .none, .some(.null): return "∅"
            case .some(.integer(let i)): return "i:\(i)"
            case .some(.real(let d)): return "r:\(d)"
            case .some(.text(let s)): return "t:\(s)"
            case .some(.blob(let bytes)): return "b:\(bytes.count):\(bytes.prefix(16))"
        }
    }
}

// MARK: - Reference import skip list

enum ReferenceImport {
    /// Tables in the JS-writer SQLite that the persist does NOT write (snapshot /
    /// embeddings / assets / operational) + the FTS shadow tables (regular tables in
    /// SQLite). The FTS BASE tables are virtual and auto-skipped by the importer;
    /// their shadow tables (`*_data`, `*_idx`, `*_content`, `*_docsize`, `*_config`)
    /// are listed here so the importer skips them too. Only the five compared user
    /// tables are imported into DB_ref.
    static let skipTables: [String] = {
        var skip = [
            // operational / non-persist tables
            "activity", "crawl_state", "document_render_index", "schema_meta",
            "snapshot_meta", "sync_checkpoint", "update_log", "framework_synonyms",
            "sqlite_sequence",
            // embeddings / raw / chunks (later slices)
            "document_chunks", "document_raw", "document_vectors",
            // assets
            "apple_font_families", "apple_font_files", "sf_symbols", "sf_symbol_renders"
        ]
        // FTS shadow tables for each FTS base in the apple-docs schema.
        let ftsBases = ["documents_fts", "documents_trigram", "documents_body_fts", "sf_symbols_fts"]
        for base in ftsBases {
            for suffix in ["_data", "_idx", "_content", "_docsize", "_config"] {
                skip.append(base + suffix)
            }
        }
        return skip
    }()
}

// MARK: - Diff report

enum PersistDiff {
    struct Report {
        struct TableResult {
            var table: String
            var nativeCount: Int
            var referenceCount: Int
            var onlyInNative: [String]
            var onlyInReference: [String]
            var isMatch: Bool { onlyInNative.isEmpty && onlyInReference.isEmpty }
        }
        var results: [TableResult] = []

        var isMatch: Bool { results.allSatisfy(\.isMatch) }

        mutating func add(table: String, native: [String], reference: [String]) {
            let nativeMS = Multiset(native)
            let refMS = Multiset(reference)
            results.append(
                TableResult(
                    table: table,
                    nativeCount: native.count,
                    referenceCount: reference.count,
                    onlyInNative: nativeMS.subtracting(refMS).sorted(),
                    onlyInReference: refMS.subtracting(nativeMS).sorted()))
        }

        func render() -> String {
            var lines: [String] = []
            lines.append("══════════════════════════════════════════════════════════════════════")
            lines.append("apple-docs CRAWL-PERSIST PARITY — native ADDB vs JS SQLite (via ADSQLImport)")
            lines.append("══════════════════════════════════════════════════════════════════════")
            for result in results {
                let mark = result.isMatch ? "✅" : "❌"
                lines.append(
                    "\(mark) \(result.table): native=\(result.nativeCount) reference=\(result.referenceCount)")
                for entry in result.onlyInNative.prefix(8) {
                    lines.append("    only NATIVE   : \(entry)")
                }
                for entry in result.onlyInReference.prefix(8) {
                    lines.append("    only REFERENCE: \(entry)")
                }
                let extraN = result.onlyInNative.count - min(result.onlyInNative.count, 8)
                let extraR = result.onlyInReference.count - min(result.onlyInReference.count, 8)
                if extraN > 0 { lines.append("    … +\(extraN) more only-native") }
                if extraR > 0 { lines.append("    … +\(extraR) more only-reference") }
            }
            lines.append("")
            lines.append(
                isMatch
                    ? "RESULT: ✅ FULL MATCH (excluding wall-clock + surrogate-id columns; FTS derived)"
                    : "RESULT: ❌ MISMATCH")
            lines.append("══════════════════════════════════════════════════════════════════════")
            return lines.joined(separator: "\n")
        }
    }

    /// A tiny multiset over strings (row counts matter: a duplicated row is a real
    /// difference). `subtracting` yields the elements (with multiplicity) present in
    /// the receiver beyond the other.
    struct Multiset {
        private var counts: [String: Int] = [:]
        init(_ elements: [String]) { for element in elements { counts[element, default: 0] += 1 } }
        func subtracting(_ other: Multiset) -> [String] {
            var out: [String] = []
            for (element, count) in counts {
                let remaining = count - (other.counts[element] ?? 0)
                if remaining > 0 { out.append(contentsOf: repeatElement(element, count: remaining)) }
            }
            return out
        }
    }
}
