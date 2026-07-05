// Minimal STORE-method (uncompressed) ZIP writer for `/api/fonts/family/<id>.zip` — a Swift
// port of the JS `src/web/lib/zip.js` `buildStoreZip`. Fonts are already-compressed binaries, so
// STORE (method 0, no DEFLATE) is the right call: smaller CPU cost, identical output size to a
// DEFLATE pass that can't shrink already-compressed data. UTF-8 entry names via the
// general-purpose Language Encoding Flag (bit 11).

import ADFCore
import Foundation

enum StoreZip {
    struct Entry: Sendable {
        let name: String
        let data: [UInt8]
    }

    /// CRC-32 (the ISO 3309 / ZIP polynomial) over `bytes` — the reflected, byte-at-a-time table
    /// algorithm (same construction as the JS `crc32`).
    static func crc32(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in bytes {
            let index = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = crc32Table[index] ^ (crc >> 8)
        }
        return crc ^ 0xFFFF_FFFF
    }

    private static let crc32Table: [UInt32] = {
        var table = [UInt32](repeating: 0, count: 256)
        for i in 0 ..< 256 {
            var c = UInt32(i)
            for _ in 0 ..< 8 {
                c = (c & 1) != 0 ? (0xEDB8_8320 ^ (c >> 1)) : (c >> 1)
            }
            table[i] = c
        }
        return table
    }()

    /// Build a STORE-method ZIP from in-memory entries: local file headers + data, the central
    /// directory, then the EOCD record. `mtime` defaults to now for every entry — the family-zip
    /// route keys its on-disk cache filename on a content hash (not the archive bytes), so a
    /// non-deterministic entry mtime doesn't affect cache identity.
    static func build(_ entries: [Entry], mtime: Date = Date()) -> [UInt8] {
        var local: [UInt8] = []
        var central: [UInt8] = []
        var offset: UInt32 = 0
        let (dosTime, dosDate) = dosDateTime(mtime)

        for entry in entries {
            let nameBytes = Array(entry.name.utf8)
            let crc = crc32(entry.data)
            let size = UInt32(entry.data.count)

            // Local file header (30 bytes + name).
            local.appendLE32(0x0403_4b50)
            local.appendLE16(20)  // version needed
            local.appendLE16(0x0800)  // flags: bit 11 = UTF-8 names
            local.appendLE16(0)  // method: 0 = STORE
            local.appendLE16(dosTime)
            local.appendLE16(dosDate)
            local.appendLE32(crc)
            local.appendLE32(size)  // compressed size
            local.appendLE32(size)  // uncompressed size
            local.appendLE16(UInt16(nameBytes.count))
            local.appendLE16(0)  // extra field length
            local.append(contentsOf: nameBytes)
            local.append(contentsOf: entry.data)

            // Central directory file header (46 bytes + name).
            central.appendLE32(0x0201_4b50)
            central.appendLE16(0x031e)  // version made by (UNIX | 30)
            central.appendLE16(20)  // version needed
            central.appendLE16(0x0800)
            central.appendLE16(0)
            central.appendLE16(dosTime)
            central.appendLE16(dosDate)
            central.appendLE32(crc)
            central.appendLE32(size)
            central.appendLE32(size)
            central.appendLE16(UInt16(nameBytes.count))
            central.appendLE16(0)  // extra
            central.appendLE16(0)  // comment
            central.appendLE16(0)  // disk
            central.appendLE16(0)  // internal attrs
            central.appendLE32(0)  // external attrs
            central.appendLE32(offset)  // local header offset
            central.append(contentsOf: nameBytes)

            offset += UInt32(30 + nameBytes.count) + size
        }

        var eocd: [UInt8] = []
        eocd.appendLE32(0x0605_4b50)
        eocd.appendLE16(0)  // disk
        eocd.appendLE16(0)  // disk with central dir
        eocd.appendLE16(UInt16(entries.count))  // entries on this disk
        eocd.appendLE16(UInt16(entries.count))  // total entries
        eocd.appendLE32(UInt32(central.count))
        eocd.appendLE32(offset)  // central dir offset
        eocd.appendLE16(0)  // zip comment length

        var out: [UInt8] = []
        out.reserveCapacity(local.count + central.count + eocd.count)
        out.append(contentsOf: local)
        out.append(contentsOf: central)
        out.append(contentsOf: eocd)
        return out
    }

    /// DOS date/time fields (the ZIP local/central header format); `year` clamps to ≥1980 (the
    /// DOS epoch), matching the JS `Math.max(1980, date.getFullYear())`.
    private static func dosDateTime(_ date: Date) -> (time: UInt16, date: UInt16) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone.current
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let year = max(1980, c.year ?? 1980)
        let dosDate = UInt16(((year - 1980) << 9) | ((c.month ?? 1) << 5) | (c.day ?? 1))
        let dosTime = UInt16(((c.hour ?? 0) << 11) | ((c.minute ?? 0) << 5) | ((c.second ?? 0) / 2))
        return (dosTime, dosDate)
    }
}
