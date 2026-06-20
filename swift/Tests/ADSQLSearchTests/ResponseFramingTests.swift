// Byte-identity golden for the §2.5 response wire layout (header `[u32 colCount][u32 rowCount]` then
// per-cell `[u8 tag][payload]`). Pins the little-endian encoding the framer now emits through
// ADFCore's `appendLE*`, so the A1 endian consolidation is provably byte-for-byte unchanged. See
// `ResponseFraming` for the full layout table.

import ADSQLModel
import Testing

@testable import ADSQLSearch

struct ResponseFramingTests {
    @Test func framesEveryCellTypeToExactBytes() {
        // One row exercising all five tags. Values chosen so the little-endian payloads are
        // hand-verifiable: i64 1, f64 2.0 (0x4000_0000_0000_0000), text "Ab", blob 00 FF, NULL.
        let rows: [[Value]] = [
            [.integer(1), .real(2.0), .text("Ab"), .blob([0x00, 0xFF]), .null]
        ]
        let out = ResponseFraming.frame(rows: rows, columnCount: 5)
        let expected: [UInt8] = [
            0x05, 0x00, 0x00, 0x00,  // colCount = 5
            0x01, 0x00, 0x00, 0x00,  // rowCount = 1
            0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,  // INT 1  (tag 1 + i64 LE)
            0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x40,  // REAL 2.0 (tag 2 + f64 LE)
            0x03, 0x02, 0x00, 0x00, 0x00, 0x41, 0x62,  // TEXT "Ab" (tag 3 + u32 len + utf8)
            0x04, 0x02, 0x00, 0x00, 0x00, 0x00, 0xFF,  // BLOB 00 FF (tag 4 + u32 len + bytes)
            0x00  // NULL (tag 0, no payload)
        ]
        #expect(out == expected)
    }

    @Test func negativeIntegerIsTwosComplementLE() {
        // The signed → unsigned bitPattern path must emit two's-complement LE (-1 → all 0xFF).
        let out = ResponseFraming.frame(rows: [[.integer(-1)]], columnCount: 1)
        let expected: [UInt8] = [
            0x01, 0x00, 0x00, 0x00,  // colCount = 1
            0x01, 0x00, 0x00, 0x00,  // rowCount = 1
            0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF  // INT -1
        ]
        #expect(out == expected)
    }

    @Test func zeroRowsEmitsHeaderOnly() {
        // A NULL/empty result is `[colCount][0]` with no cells.
        let out = ResponseFraming.frame(rows: [], columnCount: 3)
        let expected: [UInt8] = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
        #expect(out == expected)
    }
}
