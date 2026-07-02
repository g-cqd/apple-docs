// S10 — native ZIP reading over the dlopen'd zlib (Gzip.swift's raw-deflate
// inflate). Replaces the `Process("unzip")` interim plan outright: the
// mobileasset fetch path (WS-D's apple-archive adapter) extracts
// `AssetData/documentation-db/*` members from a multi-GB archive, so entries
// stream through a chunked inflate to an injected sink — never fully in
// memory. ZIP64 (EOCD locator + the 0x0001 extra field) is supported; the
// pinned Apple asset routinely crosses the 32-bit size fields.
//
// Foundation-free like the rest of ADArchive: POSIX open/pread only.

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

public enum Unzip {
    /// One central-directory entry.
    public struct Entry: Sendable {
        public let name: String
        /// 0 = stored, 8 = deflate (anything else is refused at extract).
        public let method: UInt16
        public let compressedSize: UInt64
        public let uncompressedSize: UInt64
        public let localHeaderOffset: UInt64
    }

    public enum UnzipError: Error, Sendable {
        case ioFailed(String)
        case notAZip
        case corrupt(String)
        case unsupportedMethod(UInt16)
        case zlibUnavailable
    }

    /// Parse the central directory (EOCD → optional ZIP64 EOCD → records).
    public static func entries(path: String) throws(UnzipError) -> [Entry] {
        let file = try ZipFile(path: path)
        defer { file.close() }
        return try centralDirectory(file)
    }

    /// Extract one entry, streaming decompressed bytes into `sink` in chunks.
    /// Verifies the produced byte count against the central directory.
    public static func extract(
        _ entry: Entry, from path: String, sink: ([UInt8]) throws -> Void
    ) throws -> Void {
        let file = try ZipFile(path: path)
        defer { file.close() }

        // Local file header: PK\3\4 … name/extra lengths at +26/+28; the entry
        // data begins after the 30-byte header + both variable fields. The
        // LOCAL extra field can differ in length from the central one, so it
        // must be re-read here.
        let header = try file.read(at: entry.localHeaderOffset, count: 30)
        guard header.count == 30, u32(header, 0) == 0x0403_4B50 else {
            throw UnzipError.corrupt("bad local header at \(entry.localHeaderOffset)")
        }
        let nameLength = UInt64(u16(header, 26))
        let extraLength = UInt64(u16(header, 28))
        var offset = entry.localHeaderOffset + 30 + nameLength + extraLength
        var remaining = entry.compressedSize

        switch entry.method {
        case 0:  // stored — a bounded copy.
            guard entry.compressedSize == entry.uncompressedSize else {
                throw UnzipError.corrupt("stored entry with mismatched sizes: \(entry.name)")
            }
            while remaining > 0 {
                let want = Int(min(remaining, 1 << 20))
                let chunk = try file.read(at: offset, count: want)
                guard !chunk.isEmpty else { throw UnzipError.corrupt("truncated stored entry: \(entry.name)") }
                try sink(chunk)
                offset += UInt64(chunk.count)
                remaining -= UInt64(chunk.count)
            }

        case 8:  // deflate — chunked raw inflate (windowBits −15).
            guard let stream = InflateStream(windowBits: -15) else { throw UnzipError.zlibUnavailable }
            defer { stream.end() }
            var produced: UInt64 = 0
            var finished = false
            while remaining > 0 && !finished {
                let want = Int(min(remaining, 1 << 20))
                let chunk = try file.read(at: offset, count: want)
                guard !chunk.isEmpty else { throw UnzipError.corrupt("truncated deflate entry: \(entry.name)") }
                offset += UInt64(chunk.count)
                remaining -= UInt64(chunk.count)
                let ok = try stream.inflate(chunk) { out in
                    produced += UInt64(out.count)
                    try sink(out)
                }
                switch ok {
                case .needsMore: continue
                case .finished: finished = true
                case .failed: throw UnzipError.corrupt("deflate stream error in \(entry.name)")
                }
            }
            guard finished, produced == entry.uncompressedSize else {
                throw UnzipError.corrupt(
                    "size mismatch in \(entry.name): produced \(produced), expected \(entry.uncompressedSize)")
            }

        default:
            throw UnzipError.unsupportedMethod(entry.method)
        }
    }

    // MARK: - central directory

    private static func centralDirectory(_ file: ZipFile) throws(UnzipError) -> [Entry] {
        // EOCD (PK\5\6): scan backward over the last 64 KiB + 22 (max comment).
        let tail = min(file.size, 65_557)
        let tailStart = file.size - tail
        let bytes = try file.read(at: tailStart, count: Int(tail))
        var eocd = -1
        var i = bytes.count - 22
        while i >= 0 {
            if u32(bytes, i) == 0x0605_4B50 {
                eocd = i
                break
            }
            i -= 1
        }
        guard eocd >= 0 else { throw UnzipError.notAZip }

        var entryCount = UInt64(u16(bytes, eocd + 10))
        var cdOffset = UInt64(u32(bytes, eocd + 16))

        // ZIP64: sentinel values route through the EOCD64 locator (PK\6\7,
        // the 20 bytes immediately before the EOCD).
        if entryCount == 0xFFFF || cdOffset == 0xFFFF_FFFF {
            let locatorPos = eocd - 20
            guard locatorPos >= 0, u32(bytes, locatorPos) == 0x0706_4B50 else {
                throw UnzipError.corrupt("zip64 sentinel without an EOCD64 locator")
            }
            let eocd64Offset = u64(bytes, locatorPos + 8)
            let eocd64 = try file.read(at: eocd64Offset, count: 56)
            guard eocd64.count == 56, u32(eocd64, 0) == 0x0606_4B50 else {
                throw UnzipError.corrupt("bad EOCD64 record")
            }
            entryCount = u64(eocd64, 32)
            cdOffset = u64(eocd64, 48)
        }

        var entries: [Entry] = []
        entries.reserveCapacity(Int(min(entryCount, 1 << 20)))
        var pos = cdOffset
        for _ in 0..<entryCount {
            let rec = try file.read(at: pos, count: 46)
            guard rec.count == 46, u32(rec, 0) == 0x0201_4B50 else {
                throw UnzipError.corrupt("bad central-directory record at \(pos)")
            }
            let method = u16(rec, 10)
            var compressed = UInt64(u32(rec, 20))
            var uncompressed = UInt64(u32(rec, 24))
            let nameLength = Int(u16(rec, 28))
            let extraLength = Int(u16(rec, 30))
            let commentLength = Int(u16(rec, 32))
            var headerOffset = UInt64(u32(rec, 42))

            let name = try file.read(at: pos + 46, count: nameLength)
            let extra = try file.read(at: pos + 46 + UInt64(nameLength), count: extraLength)

            // ZIP64 extra (id 0x0001): fields appear IN ORDER, only for the
            // header values that carried the 0xFFFFFFFF sentinel.
            if compressed == 0xFFFF_FFFF || uncompressed == 0xFFFF_FFFF || headerOffset == 0xFFFF_FFFF {
                var cursor = 0
                while cursor + 4 <= extra.count {
                    let id = u16(extra, cursor)
                    let size = Int(u16(extra, cursor + 2))
                    if id == 0x0001 {
                        var field = cursor + 4
                        if uncompressed == 0xFFFF_FFFF, field + 8 <= extra.count {
                            uncompressed = u64(extra, field)
                            field += 8
                        }
                        if compressed == 0xFFFF_FFFF, field + 8 <= extra.count {
                            compressed = u64(extra, field)
                            field += 8
                        }
                        if headerOffset == 0xFFFF_FFFF, field + 8 <= extra.count {
                            headerOffset = u64(extra, field)
                        }
                        break
                    }
                    cursor += 4 + size
                }
            }

            entries.append(
                Entry(
                    name: String(decoding: name, as: UTF8.self), method: method,
                    compressedSize: compressed, uncompressedSize: uncompressed,
                    localHeaderOffset: headerOffset))
            pos += UInt64(46 + nameLength + extraLength + commentLength)
        }
        return entries
    }

    // MARK: - little-endian readers

    private static func u16(_ b: [UInt8], _ i: Int) -> UInt16 {
        UInt16(b[i]) | (UInt16(b[i + 1]) << 8)
    }
    private static func u32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | (UInt32(b[i + 1]) << 8) | (UInt32(b[i + 2]) << 16) | (UInt32(b[i + 3]) << 24)
    }
    private static func u64(_ b: [UInt8], _ i: Int) -> UInt64 {
        UInt64(u32(b, i)) | (UInt64(u32(b, i + 4)) << 32)
    }
}

/// A pread-based random-access file (no Foundation).
private struct ZipFile {
    let fd: Int32
    let size: UInt64

    init(path: String) throws(Unzip.UnzipError) {
        let fd = path.withCString { open($0, O_RDONLY) }
        guard fd >= 0 else { throw Unzip.UnzipError.ioFailed("open \(path)") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_size >= 22 else {
            _ = Darwin_close(fd)
            throw Unzip.UnzipError.notAZip
        }
        self.fd = fd
        self.size = UInt64(info.st_size)
    }

    func close() {
        _ = Darwin_close(fd)
    }

    /// pread exactly-or-less; short reads at EOF return what's there.
    func read(at offset: UInt64, count: Int) throws(Unzip.UnzipError) -> [UInt8] {
        guard count > 0 else { return [] }
        var out = [UInt8](repeating: 0, count: count)
        let got = out.withUnsafeMutableBytes { raw in
            pread(fd, raw.baseAddress, count, off_t(offset))
        }
        guard got >= 0 else { throw Unzip.UnzipError.ioFailed("pread") }
        if got < count { out.removeLast(count - got) }
        return out
    }
}

/// `close(2)` under a name that can't collide with method names.
@inline(__always)
private func Darwin_close(_ fd: Int32) -> Int32 { close(fd) }
