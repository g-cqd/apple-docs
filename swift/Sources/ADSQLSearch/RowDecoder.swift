public import ADDBExec  // SQLRow (in the public signatures)
import ADSQLModel  // Value + its cases, matched in the method bodies (MemberImportVisibility)

/// Ergonomic, by-name typed extraction over an ADDB ``SQLRow`` — the migration-aware replacement for the
/// positional `stmt.text(0)` / `stmt.int(1)` decoding the raw-SQLite read path uses (RFC 0006 H6). The
/// ported `documents`/`roots`/asset/facet reads decode through this one type instead of re-rolling the
/// `if case .text(let s) = row[col]` boilerplate per call site, and by-NAME access survives a projection
/// reorder (the positional decoders silently mis-map on column drift).
///
/// `Value` → Swift coercions mirror SQLite's read-side affinity loosely: `text`/`integer`/`blob` map to
/// their natural Swift type; `double` accepts a stored `integer` (SQLite returns either for a REAL-affinity
/// column) and vice-versa for `int`-from-`real` only when integral. A missing column or a type mismatch is
/// `nil` (no trap), matching the optional shape of the positional accessors it replaces.
public struct RowDecoder: Sendable {
    public let row: SQLRow
    public init(_ row: SQLRow) { self.row = row }

    /// `TEXT` cell, or nil for any other type / absent column.
    public func text(_ column: String) -> String? {
        if case .text(let s) = row[column] { return s }
        return nil
    }

    /// `INTEGER` cell, or nil. (A `REAL` is NOT silently truncated here — use ``double(_:)`` for those.)
    public func int(_ column: String) -> Int64? {
        if case .integer(let i) = row[column] { return i }
        return nil
    }

    /// `REAL` cell, accepting a stored `INTEGER` (a numeric column may hold either) — matching the
    /// positional `stmt.double(_:)` the SQLite path used for `rank`-style columns.
    public func double(_ column: String) -> Double? {
        switch row[column] {
            case .real(let d): return d
            case .integer(let i): return Double(i)
            default: return nil
        }
    }

    /// `BLOB` cell, or nil — the binary-vector reads (`vec_bin`/`vec_i8`).
    public func blob(_ column: String) -> [UInt8]? {
        if case .blob(let b) = row[column] { return b }
        return nil
    }

    /// `true` when the column is SQL NULL or absent — the explicit-null probe the codecs use before a
    /// default-fallback (distinct from a present-but-other-type cell, which the typed getters return nil for).
    public func isNull(_ column: String) -> Bool {
        switch row[column] {
            case .none, .some(.null): return true
            default: return false
        }
    }
}

extension SQLRow {
    /// `RowDecoder(self)` — `row.decode().text("title")` at a read call site.
    public func decode() -> RowDecoder { RowDecoder(self) }
}
