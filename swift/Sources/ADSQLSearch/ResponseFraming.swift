import ADSQL

/// The response wire format (the `ad_storage_search_pages` return
/// payload): a header `[u32 colCount][u32 rowCount]` followed by
/// `rowCount × colCount` cells in row-major order, each a `[u8 tag][payload]`:
///
/// | tag | type | payload |
/// |-----|------|-------------------------------|
/// | `0` | NULL | (none) |
/// | `1` | INT | `[i64 LE]` |
/// | `2` | REAL | `[f64 LE]` (IEEE-754 bit pattern, LE) |
/// | `3` | TEXT | `[u32 len][utf8 bytes]` |
/// | `4` | BLOB | `[u32 len][raw bytes]` |
///
/// Every multi-byte field is little-endian. The integers are emitted by explicit
/// byte shifts (never a host-`withUnsafeBytes` reinterpret), so the bytes are
/// identical regardless of CPU endianness — a requirement for the Linux gate.
enum ResponseFraming {
    /// Cell type tags (§2.5).
    enum Tag: UInt8 {
        case null = 0
        case int = 1
        case real = 2
        case text = 3
        case blob = 4
    }

    /// Frames `rows` (each a positional `[Value]`, all the same width) into the
    /// §2.5 byte layout. `columnCount` is emitted in the header even when there
    /// are zero rows (a NULL/empty result is `[colCount][0]` with no cells).
    static func frame(rows: [[Value]], columnCount: Int) -> [UInt8] {
        var out: [UInt8] = []
        // A rough reserve: header + one tag byte per cell + 8 bytes for the common
        // numeric/length payload. TEXT/BLOB grow it further; `append` handles that.
        out.reserveCapacity(8 + rows.count * columnCount * 9)
        appendUInt32(&out, UInt32(truncatingIfNeeded: columnCount))
        appendUInt32(&out, UInt32(truncatingIfNeeded: rows.count))
        for row in rows {
            for value in row {
                appendCell(&out, value)
            }
        }
        return out
    }

    // MARK: - Cells

    private static func appendCell(_ out: inout [UInt8], _ value: Value) {
        switch value {
            case .null:
                out.append(Tag.null.rawValue)
            case .integer(let i):
                out.append(Tag.int.rawValue)
                appendInt64(&out, i)
            case .real(let d):
                out.append(Tag.real.rawValue)
                appendUInt64(&out, d.bitPattern)
            case .text(let s):
                out.append(Tag.text.rawValue)
                let bytes = Array(s.utf8)
                appendUInt32(&out, UInt32(truncatingIfNeeded: bytes.count))
                out.append(contentsOf: bytes)
            case .blob(let bytes):
                out.append(Tag.blob.rawValue)
                appendUInt32(&out, UInt32(truncatingIfNeeded: bytes.count))
                out.append(contentsOf: bytes)
        }
    }

    // MARK: - Little-endian primitives (endianness-independent)

    private static func appendUInt32(_ out: inout [UInt8], _ value: UInt32) {
        out.append(UInt8(truncatingIfNeeded: value))
        out.append(UInt8(truncatingIfNeeded: value >> 8))
        out.append(UInt8(truncatingIfNeeded: value >> 16))
        out.append(UInt8(truncatingIfNeeded: value >> 24))
    }

    private static func appendUInt64(_ out: inout [UInt8], _ value: UInt64) {
        var shifted = value
        for _ in 0 ..< 8 {
            out.append(UInt8(truncatingIfNeeded: shifted))
            shifted >>= 8
        }
    }

    private static func appendInt64(_ out: inout [UInt8], _ value: Int64) {
        appendUInt64(&out, UInt64(bitPattern: value))
    }
}
