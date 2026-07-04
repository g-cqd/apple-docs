// ADWrite — SPIKE foundation for the native apple-docs crawl WRITER on the ADDB
// engine (own on-disk format "ADSQLv0", NOT libsqlite3).
//
// This is a SPIKE, not the full writer. It proves the ADDB write path end to end
// from apple-docs/swift, and pins the exact ADDB API the full writer (the 32
// apple-docs schema migrations + crawl persist) will be built on:
//
//   open/create a writable DB → run DDL → prepared INSERT + bind (text / int /
//   real / BLOB / NULL) inside ONE transaction → capture lastInsertRowid →
//   read the rows back via the query API.
//
// It writes a fresh ADDB database at a caller-supplied temp dir using a couple of
// the REAL apple-docs DDL statements (roots + pages, from
// apple-docs/src/storage/migrations/v1-initial-schema.js). Adaptations for ADDB's
// strict typing are documented inline at each DDL string (see the `ddl…` lets).

// `import ADDB` is the single curated entry point: it re-exports ADDBCore (the
// engine façade: `Database`, `DatabaseOptions`, `DBError`) and ADDBExec (the SQL
// executor: `prepare`/`Statement`/`SQLRow`/`SQLTransaction`/`RunResult`). The
// writer never needs the `@_spi(ADDBEngine)` key/value surface. Plain (internal)
// imports: `SpikeReport`'s public surface is all stdlib types, so neither module
// appears in a public signature (the manifest's InternalImportsByDefault +
// -warnings-as-errors would reject an unused `public import`).
import ADDB
// `Value` (the bound-parameter / result-cell type) lives in ADSQL's `ADSQLModel`.
import ADSQLModel

/// The outcome of one spike run, returned so a caller (CLI verb or a test) can
/// assert on it. All counts/ids come straight from the ADDB API.
public struct SpikeReport: Sendable {
    /// On-disk path of the freshly created ADDB ("ADSQLv0") database file.
    public let databasePath: String
    /// The `lastInsertRowid` ADDB returned for the inserted `roots` row.
    public let rootRowid: Int64
    /// The `lastInsertRowid` ADDB returned for each inserted `pages` row, in order.
    public let pageRowids: [Int64]
    /// The rows read back from `roots` (rendered for printing).
    public let rootsReadBack: [String]
    /// The rows read back from `pages` (rendered for printing).
    public let pagesReadBack: [String]
    /// The committed generation after the writes (ADDB MVCC commit counter).
    public let finalGeneration: UInt64
}

public enum WriteSpike {
    /// Creates the two apple-docs-representative tables (roots + pages) + secondary indexes via
    /// the ADDB engine; each DDL is auto-committed in its own write transaction.
    private static func createSpikeSchema(_ db: Database) throws {
        // ── 2. DDL — two apple-docs-representative tables via the ADDB engine ─
        // These are the real apple-docs `roots` + `pages` definitions from
        // v1-initial-schema.js, adapted to ADDB's STRICT relational model.
        //
        // Adaptations vs the JS/SQLite DDL (documented for the porting effort):
        //   • `id INTEGER PRIMARY KEY AUTOINCREMENT` → kept VERBATIM. ADDB parses
        //     AUTOINCREMENT and treats `INTEGER PRIMARY KEY` as the rowid alias,
        //     so `lastInsertRowid` and rowid semantics are preserved (same as
        //     SQLite). No change required.
        //   • Column constraints `NOT NULL`, `UNIQUE`, `DEFAULT '…'`,
        //     `DEFAULT 0`, and `REFERENCES roots(id)` are all carried verbatim —
        //     ADDB's frontend parses them.
        //   • `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` are
        //     supported verbatim.
        // The ONLY semantic difference from SQLite is at the VALUES boundary:
        // ADDB columns are strictly typed (a TEXT column stores TEXT or NULL —
        // never a stray integer), so the writer must bind the right `Value` case
        // per column (it already does; see step 3). No DDL text changed here.
        let ddlRoots = """
            CREATE TABLE IF NOT EXISTS roots (
              id           INTEGER PRIMARY KEY AUTOINCREMENT,
              slug         TEXT    NOT NULL UNIQUE,
              display_name TEXT    NOT NULL,
              kind         TEXT    NOT NULL DEFAULT 'unknown',
              status       TEXT    NOT NULL DEFAULT 'active',
              source       TEXT    NOT NULL,
              page_count   INTEGER NOT NULL DEFAULT 0,
              seed_path    TEXT,
              first_seen   TEXT    NOT NULL,
              last_seen    TEXT    NOT NULL
            )
            """
        // `pages` carries a FK to roots(id), a UNIQUE path, and many nullable
        // TEXT columns. Verbatim from v1-initial-schema.js except for one added
        // column used purely to exercise a BLOB bind on the write path:
        //   • `content_blob BLOB` — NOT in the JS schema. Added so the spike binds
        //     a real BLOB value (the JS writer stores everything as TEXT/INTEGER;
        //     the native writer may later store compressed section bytes as a
        //     BLOB, so proving the BLOB bind now is the point). Flagged as a spike
        //     addition, not a schema change to port.
        let ddlPages = """
            CREATE TABLE IF NOT EXISTS pages (
              id            INTEGER PRIMARY KEY AUTOINCREMENT,
              root_id       INTEGER NOT NULL REFERENCES roots(id),
              path          TEXT    NOT NULL UNIQUE,
              url           TEXT    NOT NULL,
              title         TEXT,
              role          TEXT,
              role_heading  TEXT,
              abstract      TEXT,
              platforms     TEXT,
              declaration   TEXT,
              etag          TEXT,
              last_modified TEXT,
              content_hash  TEXT,
              downloaded_at TEXT,
              converted_at  TEXT,
              status        TEXT    NOT NULL DEFAULT 'active',
              content_blob  BLOB
            )
            """
        // Two of the real apple-docs secondary indexes, verbatim.
        let ddlIndexPagesRoot = "CREATE INDEX IF NOT EXISTS idx_pages_root ON pages(root_id)"
        let ddlIndexPagesRole = "CREATE INDEX IF NOT EXISTS idx_pages_role ON pages(role)"

        // Each `prepare(sql).run()` for a DDL statement opens and commits its own
        // exclusive write transaction (DDL is auto-committed by the executor).
        // The full writer would instead run these inside ADSQLMigrate migrations
        // (which wrap the body + the schema_version bump in ONE MVCC commit).
        try db.prepare(ddlRoots).run()
        try db.prepare(ddlPages).run()
        try db.prepare(ddlIndexPagesRoot).run()
        try db.prepare(ddlIndexPagesRole).run()
    }

    /// Runs the full write→read round-trip against a fresh ADDB database created
    /// under `directory`. Returns a ``SpikeReport`` for inspection; the CLI verb
    /// prints it. Throws the engine's `DBError` unchanged on any failure.
    ///
    /// - Parameter directory: an existing, writable directory (a temp dir for the
    ///   spike). The database file is created at `<directory>/addb-write-spike.adsql`.
    /// - Returns: a ``SpikeReport`` capturing the write→read round-trip outcome.
    /// - Throws: the engine's `DBError`, unchanged, on any failure.
    public static func run(inDirectory directory: String) throws -> SpikeReport {
        // ── 1. Open / create a fresh writable ADDB database ──────────────────
        // `DatabaseOptions()` defaults are already the writable profile we want:
        // readOnly=false, createIfMissing=true, durability=.barrier. The engine
        // has no `:memory:` mode — a real file under the temp dir is the idiom
        // (every ADDB test opens a throwaway on-disk db the same way).
        let path =
            directory.hasSuffix("/")
            ? directory + "addb-write-spike.adsql"
            : directory + "/addb-write-spike.adsql"
        let db = try Database.open(at: path, options: DatabaseOptions())
        defer { db.close() }

        // ── 2. DDL — create the apple-docs-representative tables + indexes ─
        try createSpikeSchema(db)

        // ── 3. INSERT a root + 2 pages via prepared INSERT + bind, in ONE txn ─
        // `db.transaction { … }` runs every statement against one shared WriteTxn
        // and commits once (a single durability point) — the batching shape the
        // crawl persist wants. `txn.run(sql, params…)` returns a `RunResult`
        // carrying `.lastInsertRowid` and `.changes`.
        //
        // Parameters are bound positionally as `Value` cases — note the explicit
        // type per column (strict typing): TEXT→`.text`, INTEGER→`.integer`,
        // BLOB→`.blob`, and a real NULL via `.null`.
        var rootRowid: Int64 = 0
        var pageRowids: [Int64] = []
        try db.transaction { (txn) throws(DBError) in
            // INSERT the root. `first_seen` / `last_seen` are NOT NULL TEXT
            // (apple-docs stores ISO-8601 strings); `seed_path` is left to its
            // column default by omission. `kind`/`status`/`page_count` likewise
            // fall to their DDL defaults by omission — proving DEFAULT works.
            let rootResult = try txn.run(
                """
                INSERT INTO roots (slug, display_name, source, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?)
                """,
                .text("swiftui"),  // slug         (TEXT NOT NULL UNIQUE)
                .text("SwiftUI"),  // display_name (TEXT NOT NULL)
                .text("seed"),  // source       (TEXT NOT NULL)
                .text("2026-06-20T00:00:00Z"),  // first_seen   (TEXT NOT NULL)
                .text("2026-06-20T00:00:00Z"))  // last_seen    (TEXT NOT NULL)
            rootRowid = rootResult.lastInsertRowid

            // Page 1 — a fully-populated row, including a real BLOB
            // (`content_blob`) and an integer FK (`root_id`).
            let page1 = try txn.run(
                """
                INSERT INTO pages
                  (root_id, path, url, title, role, abstract, status, content_blob)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                .integer(rootRowid),  // root_id  (INTEGER NOT NULL, FK)
                .text("/documentation/swiftui/view"),  // path     (TEXT NOT NULL UNIQUE)
                .text("https://developer.apple.com/documentation/swiftui/view"),  // url (TEXT NOT NULL)
                .text("View"),  // title    (TEXT)
                .text("symbol"),  // role     (TEXT)
                .text("A type that represents part of your app's UI."),  // abstract (TEXT)
                .text("active"),  // status   (TEXT NOT NULL)
                .blob([0xDE, 0xAD, 0xBE, 0xEF]))  // content_blob (BLOB) — BLOB bind
            pageRowids.append(page1.lastInsertRowid)

            // Page 2 — exercises a real NULL bind: `title` is NULL (nullable TEXT),
            // and `content_blob` is omitted (also NULL by default). This proves
            // both an explicit `.null` bind and column-default NULL.
            let page2 = try txn.run(
                """
                INSERT INTO pages
                  (root_id, path, url, title, role, abstract, status)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                .integer(rootRowid),  // root_id  (INTEGER NOT NULL, FK)
                .text("/documentation/swiftui/text"),  // path     (TEXT NOT NULL UNIQUE)
                .text("https://developer.apple.com/documentation/swiftui/text"),  // url (TEXT NOT NULL)
                .null,  // title    (TEXT) — explicit NULL bind
                .text("symbol"),  // role     (TEXT)
                .text("A view that displays one or more lines of read-only text."),  // abstract (TEXT)
                .text("active"))  // status   (TEXT NOT NULL)
            pageRowids.append(page2.lastInsertRowid)
        }

        // ── 4. Read the rows back via the ADDB query API (round-trip proof) ──
        // `prepare(sql).all()` runs in a read snapshot and returns `[SQLRow]`;
        // each `SQLRow` is positional (`row[i]`) and name-addressable
        // (`row["col"]`), yielding a `Value`.
        let rootsReadBack =
            try db.prepare(
                "SELECT id, slug, display_name, kind, status, page_count FROM roots ORDER BY id"
            )
            .all()
            .map { row in
                "root #\(render(row["id"])) slug=\(render(row["slug"])) "
                    + "name=\(render(row["display_name"])) kind=\(render(row["kind"])) "
                    + "status=\(render(row["status"])) page_count=\(render(row["page_count"]))"
            }

        let pagesReadBack =
            try db.prepare(
                "SELECT id, root_id, path, title, role, status, content_blob FROM pages ORDER BY id"
            )
            .all()
            .map { row in
                "page #\(render(row["id"])) root_id=\(render(row["root_id"])) "
                    + "path=\(render(row["path"])) title=\(render(row["title"])) "
                    + "role=\(render(row["role"])) status=\(render(row["status"])) "
                    + "content_blob=\(render(row["content_blob"]))"
            }

        return SpikeReport(
            databasePath: db.path,
            rootRowid: rootRowid,
            pageRowids: pageRowids,
            rootsReadBack: rootsReadBack,
            pagesReadBack: pagesReadBack,
            finalGeneration: db.generation)
    }

    /// Renders a result `Value` for printing: NULL as `NULL`, BLOB as a hex
    /// dump (so the round-tripped bytes are visible), the rest by their payload.
    private static func render(_ value: Value?) -> String {
        switch value {
            case .none, .some(.null): return "NULL"
            case .some(.integer(let i)): return String(i)
            case .some(.real(let d)): return String(d)
            case .some(.text(let s)): return s
            case .some(.blob(let bytes)):
                // Hand-rolled hex (no Foundation in this leaf target).
                let hexDigits = Array("0123456789ABCDEF")
                var out = "0x"
                for byte in bytes {
                    out.append(hexDigits[Int(byte >> 4)])
                    out.append(hexDigits[Int(byte & 0x0F)])
                }
                return out
        }
    }
}
