// The native-engine `StorageBackend`. Reads a crawl-written ADDB corpus (its own
// on-disk `ADSQLv0` format) through the in-process ADDB SQL engine, so the SAME
// `StorageConnection` read methods that run over libsqlite3 also run over ADDB —
// no libsqlite3, no FFI. Selected by `openStorageBackend` when the file carries
// the ADDB magic.
//
// Two routing choices mirror the task:
//   • the FTS ranked search (`searchPagesFramed*` / `nativeFtsRows`) routes to
//     the parity-proven `ADSQLSearch` denorm path (`searchPagesFramedDenorm` /
//     `searchPagesDenormRows`), NOT a re-run of `searchPagesSQL`;
//   • every other read (readDocument, browse, status, sections, …) runs its
//     existing SQL through a generic `ADDBStatement` whose rows are materialized
//     on first `step` and exposed through the same accessor surface the SQLite
//     statement uses, so the row decoders and the shared framer are unchanged.

import ADDB
import ADDBExec
import ADDBFTS
import ADDBJSON
import ADSQLModel
import ADSQLSearch

final class ADDBBackend: StorageBackend, @unchecked Sendable {
    let db: Database
    let hasTrigram: Bool
    let hasBodyFts: Bool
    let hasSections: Bool
    let hasRelationships: Bool
    private var cache: [String: ADDBStatement] = [:]

    /// nil unless `path` is an ADDB (`ADSQLv0`) file that opens. Detection is a
    /// read-only magic probe (no write, no writer lock, no modification of a
    /// non-ADDB file); on a hit the corpus is reopened writable so
    /// `prepareForDenormServing` can populate the v28 denorm columns the
    /// serving query reads.
    init?(path: String) {
        // Read-only probe: a SQLite file (or any non-ADDB file) throws `badMagic`
        // here, before any lock/write, so falling back to libsqlite3 is safe.
        guard
            (try? Database.open(at: path, options: DatabaseOptions(readOnly: true, createIfMissing: false)))
                != nil
        else { return nil }
        // It is an ADDB corpus — reopen writable to serve (the denorm backfill writes).
        guard
            let database = try? Database.open(
                at: path, options: DatabaseOptions(readOnly: false, createIfMissing: false))
        else { return nil }

        database.enableFullTextSearch()
        database.enableJSON()
        // Populate `documents.{title_lc,key_lc,year_num,track_lc,root_display,root_slug}` so
        // `searchPagesFramedDenorm` is a faithful rewrite of `searchPagesSQL`. Best-effort:
        // a corpus already prepared (or missing the columns) still serves the non-search reads.
        try? database.prepareForDenormServing()

        self.db = database
        self.hasTrigram = ADDBBackend.tableExists(database, "documents_trigram")
        self.hasBodyFts = ADDBBackend.tableExists(database, "documents_body_fts")
        self.hasSections = ADDBBackend.tableExists(database, "document_sections")
        self.hasRelationships = ADDBBackend.tableExists(database, "document_relationships")
    }

    deinit { db.close() }

    func statement(_ sql: String) -> (any StorageStatement)? {
        if let existing = cache[sql] { return existing }
        let prepared = ADDBStatement(db: db, sql: sql)
        cache[sql] = prepared
        return prepared
    }

    func prepareUncached(_ sql: String) -> (any StorageStatement)? {
        ADDBStatement(db: db, sql: sql)
    }

    func tableExists(_ name: String) -> Bool { ADDBBackend.tableExists(db, name) }

    /// A bounded `SELECT` probe: an existing table (empty or not) executes and
    /// returns; a missing one throws `noSuchTable`. Dialect-neutral, and correct
    /// for empty tables (unlike a row-count check).
    private static func tableExists(_ db: Database, _ name: String) -> Bool {
        do {
            _ = try db.prepare("SELECT 1 FROM \"\(name)\" LIMIT 1").all()
            return true
        } catch {
            return false
        }
    }

    // MARK: - searchPages (routed to the parity-proven denorm path)

    func searchPagesFramed(_ params: SearchPagesParams) -> [UInt8]? {
        try? db.searchPagesFramedDenorm(params.adsqlSearch)
    }

    func searchPagesFramedJSON(_ params: SearchPagesParams) -> [UInt8]? {
        // Frame the SAME denorm rows as a JSON array of objects, reusing the
        // shared `RowFraming` over an `ADDBStatement` bound with the denorm bag.
        let stmt = ADDBStatement(db: db, sql: SearchQuery.denormSQL)
        stmt.bindRawNamed(SearchQuery.denormBindings(for: params.adsqlSearch))
        var out: [UInt8] = []
        out.reserveCapacity(8192)
        guard stmt.runJSON(into: &out) else { return nil }
        return out
    }

    func nativeFtsRows(_ params: SearchPagesParams) -> [SearchRow]? {
        guard let rows = try? db.searchPagesDenormRows(params.adsqlSearch) else { return nil }
        return rows.map { $0.storageSearchRow }
    }
}

/// A generic ADDB statement: accumulates binds, then on first `step` executes
/// `db.prepare(sql).all(params)` and iterates the materialized `[SQLRow]`.
/// Exposes the identical accessor set as `SQLiteStatement`, mapping each `Value`
/// cell onto the frozen `SQLite.type*` constants.
final class ADDBStatement: StorageStatement {
    private let db: Database
    private let sql: String
    private var named: [String: Value] = [:]
    private var positional: [Value] = []

    private var executed = false
    private var failed = false
    private var rows: [SQLRow] = []
    private var header: SQLColumnHeader?
    private var cursor = -1

    init(db: Database, sql: String) {
        self.db = db
        self.sql = sql
    }

    // MARK: binding

    func bind(_ name: String, _ value: BindValue) {
        named[Self.strip(name)] = value.adsqlValue
    }

    func bindText(_ index: Int32, _ value: String) {
        setPositional(index, .text(value))
    }

    func bindInt64(_ index: Int32, _ value: Int64) {
        setPositional(index, .integer(value))
    }

    /// Sets the whole named bag directly (the search JSON path binds the
    /// `ADSQLSearch` denorm bag, which is already sigil-free `Value`s).
    func bindRawNamed(_ bag: [String: Value]) {
        named = bag
    }

    private func setPositional(_ index: Int32, _ value: Value) {
        let i = Int(index) - 1
        guard i >= 0 else { return }
        while positional.count <= i { positional.append(.null) }
        positional[i] = value
    }

    /// Strips a leading `$` / `:` sigil — ADDB resolves named params by bare name.
    private static func strip(_ name: String) -> String {
        guard let first = name.first, first == "$" || first == ":" else { return name }
        return String(name.dropFirst())
    }

    // MARK: execution

    private func executeIfNeeded() {
        guard !executed else { return }
        executed = true
        do {
            let result = try db.prepare(sql).all(SQLParameters(positional: positional, named: named))
            rows = result
            header = result.first?.header
        } catch {
            failed = true
            rows = []
            header = nil
        }
    }

    func step() -> Int32 {
        executeIfNeeded()
        if failed { return SQLite.ok }  // neither .row nor .done ⇒ callers treat as error/empty
        cursor += 1
        return cursor < rows.count ? SQLite.row : SQLite.done
    }

    func reset() {
        executed = false
        failed = false
        rows = []
        header = nil
        cursor = -1
        named = [:]
        positional = []
    }

    // MARK: column metadata

    func columnCount() -> Int32 {
        executeIfNeeded()
        if let header { return Int32(header.names.count) }
        return Int32(rows.first?.values.count ?? 0)
    }

    func columnName(_ col: Int32) -> String? {
        executeIfNeeded()
        guard let header, col >= 0, Int(col) < header.names.count else { return nil }
        return header.names[Int(col)]
    }

    func columnType(_ col: Int32) -> Int32 {
        switch currentValue(col) {
            case .some(.integer): return SQLite.typeInteger
            case .some(.real): return SQLite.typeFloat
            case .some(.text): return SQLite.typeText
            case .some(.blob): return SQLite.typeBlob
            default: return SQLite.typeNull  // .null or out-of-range
        }
    }

    func isNull(_ col: Int32) -> Bool {
        switch currentValue(col) {
            case .none, .some(.null): return true
            default: return false
        }
    }

    // MARK: typed cell accessors

    func text(_ col: Int32) -> String? {
        if case .text(let s)? = currentValue(col) { return s }
        return nil
    }

    /// INTEGER cell, coercing a stored REAL (matching `sqlite3_column_int64`'s
    /// numeric affinity for the columns the readers pull as ints).
    func int(_ col: Int32) -> Int64? {
        switch currentValue(col) {
            case .some(.integer(let i)): return i
            case .some(.real(let d)): return Int64(d)
            default: return nil
        }
    }

    /// REAL cell, accepting a stored INTEGER (a numeric column may hold either) —
    /// matching `sqlite3_column_double` for `rank`/`sort_order`.
    func double(_ col: Int32) -> Double? {
        switch currentValue(col) {
            case .some(.real(let d)): return d
            case .some(.integer(let i)): return Double(i)
            default: return nil
        }
    }

    func blob(_ col: Int32) -> [UInt8]? {
        if case .blob(let b)? = currentValue(col) { return b }
        return nil
    }

    func withColumnTextBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void) {
        if case .text(let s)? = currentValue(col) {
            let bytes = Array(s.utf8)
            bytes.withUnsafeBufferPointer(body)
        } else {
            body(UnsafeBufferPointer(start: nil, count: 0))
        }
    }

    func withColumnBlobBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void) {
        if case .blob(let b)? = currentValue(col) {
            b.withUnsafeBufferPointer(body)
        } else {
            body(UnsafeBufferPointer(start: nil, count: 0))
        }
    }

    /// The current row's `col`-th `Value`, or nil when not positioned on a row /
    /// out of range.
    private func currentValue(_ col: Int32) -> Value? {
        guard cursor >= 0, cursor < rows.count else { return nil }
        let values = rows[cursor].values
        guard col >= 0, Int(col) < values.count else { return nil }
        return values[Int(col)]
    }
}

// MARK: - conversions

extension BindValue {
    /// The `StorageStatement` bind value as an ADSQL `Value`.
    var adsqlValue: Value {
        switch self {
            case .null: return .null
            case .int(let i): return .integer(i)
            case .double(let d): return .real(d)
            case .text(let s): return .text(s)
        }
    }
}

extension SearchPagesParams {
    /// The storage request bag as the `ADSQLSearch` one (field-for-field; the
    /// `deprecatedMode` string is carried through and split by the denorm bindings).
    var adsqlSearch: ADSQLSearch.SearchPagesParams {
        ADSQLSearch.SearchPagesParams(
            query: query, raw: raw, limit: limit, framework: framework, sourceType: sourceType,
            sourcesJSON: sourcesJson, kind: kind, language: language, year: year, trackLike: trackLike,
            deprecatedMode: deprecatedMode, minIOS: minIos, minMacOS: minMacos, minWatchOS: minWatchos,
            minTVOS: minTvos, minVisionOS: minVisionos)
    }
}

extension SearchProjectionRow {
    /// The decoded denorm projection row as the storage `SearchRow` the cascade
    /// consumes (same 24 fields, in order).
    var storageSearchRow: SearchRow {
        var r = SearchRow(path: path)
        r.title = title
        r.role = role
        r.roleHeading = roleHeading
        r.abstract = abstract
        r.declaration = declaration
        r.platforms = platforms
        r.minIos = minIOS
        r.minMacos = minMacOS
        r.minWatchos = minWatchOS
        r.minTvos = minTVOS
        r.minVisionos = minVisionOS
        r.framework = framework
        r.rootSlug = rootSlug
        r.sourceType = sourceType
        r.sourceMetadata = sourceMetadata
        r.urlDepth = urlDepth
        r.isReleaseNotes = isReleaseNotes
        r.isDeprecated = isDeprecated
        r.isBeta = isBeta
        r.docKind = docKind
        r.language = language
        r.rank = rank
        r.tier = tier
        return r
    }
}
