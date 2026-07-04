// The storage-backend abstraction. `StorageConnection`'s read methods used to
// talk directly to a libsqlite3 `Connection` / `PreparedStatement`; they now
// talk to these two protocols, so the SAME read path runs on EITHER libsqlite3
// (`SQLiteConnection` / `SQLiteStatement`) or the native ADDB engine
// (`ADDBBackend` / `ADDBStatement`). The corpus format is detected at open time
// (`openStorageBackend`), so every existing call site keeps using
// `StorageConnection` unchanged.
//
// The step-result and column-type vocabulary is the frozen sqlite3 integer set
// (`SQLite.row` = 100, `SQLite.done` = 101, `SQLite.type*` = 1…5 in
// `SQLiteLib.swift`): the SQLite backend returns them natively and the ADDB
// backend maps its `Value` cells onto the same constants, so the shared row
// decoders (`SearchRow.decode`, `CorpusStats`, `Browse`, …) and the shared
// framer below are backend-agnostic.

/// A bound value for a named or positional parameter. `.null` binds SQL NULL.
/// Backend-neutral: the SQLite statement binds it through `sqlite3_bind_*`, the
/// ADDB statement maps it to an ADSQL `Value`.
enum BindValue {
    case null
    case int(Int64)
    case double(Double)
    case text(String)
}

/// The read-connection surface the storage read methods use. One implementation
/// wraps libsqlite3 (`SQLiteConnection`), the other the ADDB engine
/// (`ADDBBackend`). Used by exactly one thread at a time (the statement cache is
/// unsynchronized), matching the pre-existing `Connection` contract.
protocol StorageBackend: AnyObject, Sendable {
    /// Snapshot-capability probes (mirror the old `Connection` stored flags), used
    /// by the search tiers / read_doc to gate optional tables.
    var hasTrigram: Bool { get }
    var hasBodyFts: Bool { get }
    var hasSections: Bool { get }
    var hasRelationships: Bool { get }

    /// The cached statement for `sql` (prepared on first use). One statement per
    /// SQL string, reused across calls — the search hot path.
    func statement(_ sql: String) -> (any StorageStatement)?
    /// A statement prepared WITHOUT caching (for variable-arity IN(?,…) SQL).
    func prepareUncached(_ sql: String) -> (any StorageStatement)?
    /// Runtime table-existence probe (mirrors `database.hasTable`).
    func tableExists(_ name: String) -> Bool

    /// The framed searchPages payload (`[u32 colCount][u32 rowCount][cells…]`),
    /// or nil on failure. SQLite runs `searchPagesSQL`; ADDB routes to the
    /// parity-proven `searchPagesFramedDenorm`.
    func searchPagesFramed(_ params: SearchPagesParams) -> [UInt8]?
    /// The searchPages result as a JSON array of objects (UTF-8), or nil on
    /// failure. SQLite frames `searchPagesSQL` rows; ADDB frames the denorm rows.
    func searchPagesFramedJSON(_ params: SearchPagesParams) -> [UInt8]?
    /// The FTS tier's decoded `[SearchRow]` when the backend has a native fast
    /// path (ADDB → `searchPagesDenormRows`), else nil so the caller runs the
    /// generic `searchPagesSQL` statement path.
    func nativeFtsRows(_ params: SearchPagesParams) -> [SearchRow]?
}

/// A prepared statement's read surface. `SQLiteStatement` wraps a cached
/// `sqlite3_stmt`; `ADDBStatement` wraps an ADDB `Statement` whose rows are
/// materialized on first `step`. Both expose the identical accessor set so the
/// row decoders and the shared framer are written once.
protocol StorageStatement: AnyObject {
    // MARK: binding
    /// Binds to the named parameter (e.g. `"$query"`). Unknown names are ignored.
    func bind(_ name: String, _ value: BindValue)
    /// Binds a String to a 1-based positional `?` parameter.
    func bindText(_ index: Int32, _ value: String)
    /// Binds an Int64 to a 1-based positional `?` parameter.
    func bindInt64(_ index: Int32, _ value: Int64)

    // MARK: stepping
    /// Steps once; returns `SQLite.row` / `SQLite.done` (or another value on error).
    func step() -> Int32
    /// Resets the cursor and clears bindings (call after a step loop).
    func reset()

    // MARK: column metadata
    func columnCount() -> Int32
    func columnName(_ col: Int32) -> String?
    /// The dynamic type of the current row's column (`SQLite.type*`).
    func columnType(_ col: Int32) -> Int32
    func isNull(_ col: Int32) -> Bool

    // MARK: typed cell accessors (current row)
    func text(_ col: Int32) -> String?
    func int(_ col: Int32) -> Int64?
    func double(_ col: Int32) -> Double?
    func blob(_ col: Int32) -> [UInt8]?

    /// Zero-copy TEXT bytes of the current row's column (UTF-8), for the framer.
    /// The buffer is valid only for the duration of `body`; empty when the cell
    /// is not TEXT.
    func withColumnTextBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void)
    /// Zero-copy BLOB bytes of the current row's column, for the framer.
    func withColumnBlobBytes(_ col: Int32, _ body: (UnsafeBufferPointer<UInt8>) -> Void)

    // MARK: framing (shared default below)
    func run(into out: inout [UInt8]) -> Bool
    func runJSON(into out: inout [UInt8]) -> Bool
}

// MARK: - shared framing

// The single framing loop, shared by BOTH backends (the ADDB statement does not
// re-roll it). It steps the statement and emits the `[u32 colCount][u32
// rowCount]` header + per-cell `[u8 tag][payload]` body over the minimal
// accessor surface above — byte-for-byte the layout the old
// `PreparedStatement.run`/`runJSON` produced (pinned by `RowCodecTests`).
extension StorageStatement {
    /// `[u32 columnCount][u32 rowCount]` then per row `columnCount` cells, each
    /// `[u8 tag][value]`: 0 NULL, 1 INTEGER [i64 LE], 2 REAL [f64 LE],
    /// 3 TEXT [u32 len][utf8], 4 BLOB [u32 len][bytes]. Returns false on a step
    /// error. Always resets before returning.
    func run(into out: inout [UInt8]) -> Bool {
        RowFraming.frame(self, into: &out)
    }

    /// A JSON array of objects keyed by column name (NULL/BLOB → null,
    /// INTEGER/REAL → number, TEXT → escaped string). Returns false on a step
    /// error. Always resets before returning.
    func runJSON(into out: inout [UInt8]) -> Bool {
        RowFraming.frameJSON(self, into: &out)
    }
}

/// The factored framing loop over the minimal `StorageStatement` interface.
enum RowFraming {
    static func frame(_ s: some StorageStatement, into out: inout [UInt8]) -> Bool {
        defer { s.reset() }
        let columnCount = s.columnCount()
        let columnHeaderOffset = out.count
        appendU32(&out, UInt32(bitPattern: columnCount))
        appendU32(&out, 0)  // rowCount placeholder, patched after stepping
        var rowCount: UInt32 = 0
        while true {
            let rc = s.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { return false }
            for col in 0 ..< columnCount { appendCell(&out, s, col) }
            rowCount &+= 1
        }
        patchU32(&out, at: columnHeaderOffset + 4, rowCount)
        return true
    }

    static func frameJSON(_ s: some StorageStatement, into out: inout [UInt8]) -> Bool {
        defer { s.reset() }
        let columnCount = s.columnCount()
        var names: [[UInt8]] = []
        names.reserveCapacity(Int(columnCount))
        for i in 0 ..< columnCount { names.append(Array((s.columnName(i) ?? "").utf8)) }
        out.append(UInt8(ascii: "["))
        var firstRow = true
        while true {
            let rc = s.step()
            if rc == SQLite.done { break }
            guard rc == SQLite.row else { return false }
            if !firstRow { out.append(UInt8(ascii: ",")) }
            firstRow = false
            out.append(UInt8(ascii: "{"))
            for col in 0 ..< columnCount {
                if col > 0 { out.append(UInt8(ascii: ",")) }
                out.append(UInt8(ascii: "\""))
                names[Int(col)].withUnsafeBufferPointer { appendJSONEscaped(&out, $0) }
                out.append(UInt8(ascii: "\""))
                out.append(UInt8(ascii: ":"))
                appendJSONCell(&out, s, col)
            }
            out.append(UInt8(ascii: "}"))
        }
        out.append(UInt8(ascii: "]"))
        return true
    }

    private static func appendCell(_ out: inout [UInt8], _ s: some StorageStatement, _ col: Int32) {
        switch s.columnType(col) {
            case SQLite.typeInteger:
                out.append(1)
                appendI64(&out, s.int(col) ?? 0)
            case SQLite.typeFloat:
                out.append(2)
                appendF64(&out, s.double(col) ?? 0)
            case SQLite.typeText:
                out.append(3)
                s.withColumnTextBytes(col) { buf in
                    appendU32(&out, UInt32(buf.count))
                    if buf.count > 0 { out.append(contentsOf: buf) }
                }
            case SQLite.typeBlob:
                out.append(4)
                s.withColumnBlobBytes(col) { buf in
                    appendU32(&out, UInt32(buf.count))
                    if buf.count > 0 { out.append(contentsOf: buf) }
                }
            default:  // SQLITE_NULL
                out.append(0)
        }
    }

    private static func appendJSONCell(_ out: inout [UInt8], _ s: some StorageStatement, _ col: Int32) {
        switch s.columnType(col) {
            case SQLite.typeInteger:
                appendInt(&out, s.int(col) ?? 0)
            case SQLite.typeFloat:
                let d = s.double(col) ?? 0
                out.append(contentsOf: (d.isFinite ? String(d) : "null").utf8)
            case SQLite.typeText:
                out.append(UInt8(ascii: "\""))
                s.withColumnTextBytes(col) { buf in
                    if buf.count > 0 { appendJSONEscaped(&out, buf) }
                }
                out.append(UInt8(ascii: "\""))
            default:  // NULL or BLOB (searchPages projects neither)
                out.append(contentsOf: "null".utf8)
        }
    }
}

// MARK: - backend factory (format detection)

/// Opens the right read backend for `path`: try the native ADDB engine first
/// (its `ADSQLv0` magic makes detection unambiguous), else fall back to
/// libsqlite3. nil when neither can open the file. `writable` is honoured only
/// by the SQLite backend (the web build's incremental cache); the ADDB backend
/// always opens writable so `prepareForDenormServing` can populate the denorm
/// columns.
func openStorageBackend(path: String, writable: Bool) -> (any StorageBackend)? {
    if let addb = ADDBBackend(path: path) { return addb }
    return SQLiteConnection(path: path, writable: writable)
}
