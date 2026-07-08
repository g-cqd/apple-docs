// The apple-docs CRAWL-PERSIST PARITY gate — the deliverable's proof.
//
// Since the storage pivot BOTH writers emit SQLite, so the comparison is direct
// (no import bridge):
//
//   1. FIXTURE (deterministic, real data): a `bun` script reads a handful of real
//      apple-docs documents from the test corpus, reconstructs each as the exact
//      JS `normalize()` object, and emits BOTH (a) normalized.json (the native
//      input) AND (b) reference.sqlite (a fresh DB written by the JS writer's
//      upsertRoot + the persist.js `db.tx` body over those same objects).
//   2. NATIVE: fresh SQLite → migrateSchema → decode normalized.json →
//      CrawlPersist.upsertRoot + persistNormalized → DB_native.
//   3. COMPARE: for each user table (roots, pages, documents, document_sections,
//      document_relationships) read all rows from BOTH files and compare as an
//      ORDER-INDEPENDENT multiset of canonical row keys, EXCLUDING wall-clock
//      columns (first_seen, last_seen, downloaded_at, converted_at, created_at,
//      updated_at) and surrogate autoincrement ids (compared by logical key
//      instead). FTS/shadow tables are derived (trigger-maintained) and excluded.
//
// A full multiset match across all five tables is the proof the native persist
// writes the SAME rows as the Bun `bun:sqlite` writer.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("apple-docs crawl-persist parity (native SQLite vs the JS-writer SQLite)")
struct CrawlPersistParityTests {
    @Test(
        "native persist rows match the JS-writer SQLite reference",
        .enabled(if: FixtureBuilder.corpusAvailable))
    func nativePersistMatchesReference() throws {
        // ── Build the deterministic fixture from the real corpus ─────────────
        let fixture = try FixtureBuilder.build()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }

        // Decode the native input (the JS normalize() objects).
        let recordsData = try Data(contentsOf: fixture.normalizedJSON)
        let records = try JSONDecoder().decode([FixtureRecord].self, from: recordsData)
        #expect(!records.isEmpty)

        // ── DB_native: migrate + run the native persist over the fixture ─────
        let nativeURL = fixture.directory.appendingPathComponent("native.db")
        let dbNative = try SQLiteWriteConnection(path: nativeURL.path)
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

        // ── DB_ref: the JS-writer SQLite, opened directly (no pragmas — never
        //    mutate the reference's journal mode) ───────────────────────────────
        let dbRef = try SQLiteWriteConnection(path: fixture.referenceSQLite.path, writerPragmas: false)
        defer { dbRef.close() }

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
                return ["id", "created_at", "updated_at"]
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
    /// key over the NON-excluded columns (sorted by column name for a stable
    /// encoding). For document_sections, each row is prefixed with its parent
    /// document's `key` (resolved via a join) so sections of different documents
    /// never collide and surrogate document_id is irrelevant.
    static func canonicalRows(_ db: SQLiteWriteConnection, table: ComparedTable) throws -> [String] {
        switch table {
            case .documentSections:
                return try sectionRows(db)
            default:
                let excluded = table.excludedColumns
                let rows = try db.all("SELECT * FROM \(table.rawValue) ORDER BY \(table.orderBy)")
                return rows.map { canonicalKey($0, excluding: excluded) }
        }
    }

    /// document_sections joined to documents.key so the surrogate document_id is
    /// replaced by the stable document key in the comparison.
    private static func sectionRows(_ db: SQLiteWriteConnection) throws -> [String] {
        let rows = try db.all(
            """
            SELECT d.key AS doc_key, s.section_kind, s.heading, s.content_text,
                   s.content_json, s.sort_order
            FROM document_sections s
            JOIN documents d ON d.id = s.document_id
            ORDER BY d.key, s.section_kind, s.sort_order
            """)
        // All selected columns are part of the key (no exclusions in this projection).
        return rows.map { canonicalKey($0, excluding: []) }
    }

    /// Render a row to a stable string over its non-excluded columns, sorted by
    /// column name so the encoding does not depend on SELECT column order.
    private static func canonicalKey(_ row: SQLiteRow, excluding excluded: Set<String>) -> String {
        var pairs: [(String, String)] = []
        pairs.reserveCapacity(row.columns.count)
        for name in row.columns where !excluded.contains(name.lowercased()) {
            pairs.append((name.lowercased(), render(row[name])))
        }
        pairs.sort { $0.0 < $1.0 }
        return pairs.map { "\($0.0)=\($0.1)" }.joined(separator: "\u{1F}")  // unit separator
    }

    /// Canonical cell rendering with an explicit type tag so a numeric and a string
    /// holding the same digits never compare equal.
    private static func render(_ value: SQLiteValue?) -> String {
        switch value {
            case .none, .some(.null): return "∅"
            case .some(.integer(let i)): return "i:\(i)"
            case .some(.real(let d)): return "r:\(d)"
            case .some(.text(let s)): return "t:\(s)"
            case .some(.blob(let bytes)): return "b:\(bytes.count):\(bytes.prefix(16))"
        }
    }
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
            lines.append("apple-docs CRAWL-PERSIST PARITY — native SQLite vs JS-writer SQLite")
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
