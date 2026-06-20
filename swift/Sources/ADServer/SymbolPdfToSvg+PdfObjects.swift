// PDF object graph (pdf-objects.js) — the first stage of the SF-Symbol PDF→SVG
// converter. Two-pass extraction of the `n g obj … endobj` blocks plus the
// `/FlateDecode` inflate (zlib RFC1950 → raw DEFLATE via `Compression`). Leans on
// the shared `PdfScan` byte helpers for every regex/string op.

import Foundation

#if canImport(Compression)
    import Compression
#endif

// MARK: - PDF object graph (pdf-objects.js)

enum PdfObjects {
    /// One stream object's byte ranges, recorded in pass 1 so pass 2 can slice it
    /// once indirect `/Length` refs can dereference. Mirrors the JS `records`
    /// array entry's stream fields.
    private struct StreamRange {
        let absStart: Int
        let endObj: Int  // absolute index of "endobj" (== headerEnd + body length)
        let headerEnd: Int
        let streamStart: Int  // index of "stream" within body
    }
    private struct Record {
        let id: String
        let dict: [String: PdfValue]
        let range: StreamRange?
    }

    /// `collectObjects(text, bytes)` — two-pass extraction. Pass 1 indexes every
    /// `n g obj … endobj` block (parsing the leading dictionary, recording any
    /// stream byte range); pass 2 slices each stream now that indirect `/Length`
    /// refs can be resolved. Works directly on the bytes (the JS latin-1 string
    /// is a 1:1 byte view).
    static func collectObjects(_ bytes: [UInt8]) -> [String: PdfObject] {
        let n = bytes.count
        var records: [Record] = []

        // /(\d+)\s+(\d+)\s+obj\b/g over the bytes — one header per step.
        var i = 0
        while i < n {
            guard let (record, nextI) = extractObjectHeaderAt(bytes, i, n) else { break }
            if let record { records.append(record) }
            i = nextI
        }

        // Pass 1: index every object (so /Length indirect refs can dereference).
        var objects: [String: PdfObject] = [:]
        var order: [String] = []
        for r in records where objects[r.id] == nil {
            objects[r.id] = PdfObject(id: r.id, dict: r.dict, stream: nil)
            order.append(r.id)
        }
        // JS `objects.set` overwrites on duplicate id (last wins); preserve that.
        for r in records {
            objects[r.id] = PdfObject(id: r.id, dict: r.dict, stream: nil)
        }

        // Pass 2: slice streams.
        for r in records {
            guard let range = r.range else { continue }
            objects[r.id]?.stream = sliceStreamData(range, lengthValue: r.dict["Length"], bytes)
        }
        return objects
    }

    /// Scan one `<int> <int> obj … endobj` block at or after `start` — one
    /// iteration of the JS `/(\d+)\s+(\d+)\s+obj\b/g` walk. Returns the parsed
    /// `Record` (nil when the candidate header doesn't validate, mirroring the JS
    /// `continue`) paired with the index to resume from; the whole result is nil
    /// to stop the walk (no further digit run — the JS loop's termination).
    private static func extractObjectHeaderAt(_ bytes: [UInt8], _ start: Int, _ n: Int)
        -> (record: Record?, nextI: Int)?
    {
        // Find the next digit run that begins an "<int> <int> obj" header.
        guard let d1 = PdfScan.nextDigitStart(bytes, from: start) else { return nil }
        var p = d1
        while p < n, PdfScan.isDigit(bytes[p]) { p += 1 }
        let num1End = p
        // \s+
        guard p < n, PdfScan.isPdfWhitespace(bytes[p]) else { return (nil, num1End) }
        while p < n, PdfScan.isPdfWhitespace(bytes[p]) { p += 1 }
        // (\d+)
        let d2 = p
        while p < n, PdfScan.isDigit(bytes[p]) { p += 1 }
        guard p > d2 else { return (nil, num1End) }
        let num2End = p  // capture before the trailing-whitespace skip (else the id gets a stray space)
        // \s+
        guard p < n, PdfScan.isPdfWhitespace(bytes[p]) else { return (nil, num1End) }
        while p < n, PdfScan.isPdfWhitespace(bytes[p]) { p += 1 }
        // obj\b
        guard PdfScan.matches(bytes, at: p, "obj"), PdfScan.isWordBoundaryAfter(bytes, p + 3) else {
            return (nil, num1End)
        }
        let id = "\(PdfScan.asciiString(bytes, d1, num1End)) \(PdfScan.asciiString(bytes, d2, num2End))"
        let headerEnd = p + 3
        guard let endObj = PdfScan.indexOf(bytes, "endobj", from: headerEnd) else {
            // No endobj: JS `continue`s without recording; advance past header.
            return (nil, headerEnd)
        }
        // body = bytes[headerEnd ..< endObj]; streamStart relative to body.
        let streamStartRel = PdfScan.indexOf(bytes, "stream", from: headerEnd, upTo: endObj)
            .map { $0 - headerEnd }
        let dictEnd = streamStartRel.map { headerEnd + $0 } ?? endObj
        let dict = parseDictionary(bytes, headerEnd, dictEnd)
        var range: StreamRange?
        if let streamStartRel {
            var absStart = headerEnd + streamStartRel + 6  // "stream".count
            if absStart < n, bytes[absStart] == 0x0D { absStart += 1 }
            if absStart < n, bytes[absStart] == 0x0A { absStart += 1 }
            range = StreamRange(
                absStart: absStart, endObj: endObj, headerEnd: headerEnd, streamStart: streamStartRel)
        }
        return (Record(id: id, dict: dict, range: range), endObj + 6)  // past "endobj"
    }

    /// Pass-2 stream slicing for one record: resolve the declared `/Length`
    /// (literal or indirect) to an absolute end; else fall back to scanning for
    /// `endstream` and trimming the trailing EOL. Returns the clamped stream bytes.
    private static func sliceStreamData(_ range: StreamRange, lengthValue: PdfValue?, _ bytes: [UInt8]) -> [UInt8] {
        let n = bytes.count
        let literalLength = resolveStreamLength(lengthValue, bytes)
        let absEnd: Int
        if let literalLength {
            absEnd = range.absStart + literalLength
        } else {
            // Fallback: scan to "endstream" within the body, trimming trailing newlines.
            let endStreamRel =
                PdfScan.indexOf(bytes, "endstream", from: range.headerEnd + range.streamStart)
                .map { $0 - range.headerEnd } ?? (range.endObj - range.headerEnd)
            var e = range.headerEnd + endStreamRel
            while e > range.absStart && (bytes[e - 1] == 0x0A || bytes[e - 1] == 0x0D) { e -= 1 }
            absEnd = e
        }
        let clampedEnd = max(range.absStart, min(absEnd, n))
        return Array(bytes[range.absStart ..< clampedEnd])
    }

    /// `resolveStreamLength(value, text)` — a finite non-negative number passes
    /// through; an indirect ref resolves via `findLiteralNumber`; else nil.
    private static func resolveStreamLength(_ value: PdfValue?, _ bytes: [UInt8]) -> Int? {
        switch value {
            case .number(let n) where n.isFinite && n >= 0:
                return Int(n)
            case .ref(let ref):
                let parts = ref.split(separator: " ")
                guard parts.count == 2, Int(parts[0]) != nil, Int(parts[1]) != nil else { return nil }
                return findLiteralNumber(bytes, String(parts[0]), String(parts[1]))
            default:
                return nil
        }
    }

    /// `findLiteralNumber(text, objNum, genNum)` — locate `objNum genNum obj
    /// <int> endobj` and return the integer body, or nil when the target isn't a
    /// bare numeric literal. The JS anchors on `(?:^|[\s\r\n])objNum\s+genNum\s+obj\b`.
    private static func findLiteralNumber(_ bytes: [UInt8], _ objNum: String, _ genNum: String) -> Int? {
        let n = bytes.count
        let objBytes = Array(objNum.utf8)
        let genBytes = Array(genNum.utf8)
        var i = 0
        while i < n {
            // Anchor: start-of-input OR a preceding whitespace byte.
            let atStart = i == 0
            let precededByWs = i > 0 && PdfScan.isPdfWhitespace(bytes[i - 1])
            guard atStart || precededByWs else {
                i += 1
                continue
            }
            var p = i
            guard PdfScan.matches(bytes, at: p, objBytes) else {
                i += 1
                continue
            }
            p += objBytes.count
            guard p < n, PdfScan.isPdfWhitespace(bytes[p]) else {
                i += 1
                continue
            }
            while p < n, PdfScan.isPdfWhitespace(bytes[p]) { p += 1 }
            guard PdfScan.matches(bytes, at: p, genBytes) else {
                i += 1
                continue
            }
            p += genBytes.count
            guard p < n, PdfScan.isPdfWhitespace(bytes[p]) else {
                i += 1
                continue
            }
            while p < n, PdfScan.isPdfWhitespace(bytes[p]) { p += 1 }
            guard PdfScan.matches(bytes, at: p, "obj"), PdfScan.isWordBoundaryAfter(bytes, p + 3) else {
                i += 1
                continue
            }
            let headerEnd = p + 3
            guard let endObj = PdfScan.indexOf(bytes, "endobj", from: headerEnd) else { return nil }
            let inner = PdfScan.jsTrimAscii(bytes, headerEnd, endObj)
            guard PdfScan.isIntegerOrDecimalLiteral(inner) else { return nil }
            return Double(inner).flatMap { $0.isFinite ? Int($0) : nil }
        }
        return nil
    }

    /// `parseDictionary(text)` — the minimal `<<…>>` parser. Returns the entries
    /// in the JS dict shape; only the slice `bytes[start..<end]` is considered.
    static func parseDictionary(_ bytes: [UInt8], _ start: Int, _ end: Int) -> [String: PdfValue] {
        guard let dictStart = PdfScan.indexOf(bytes, "<<", from: start, upTo: end) else { return [:] }
        var i = dictStart + 2
        var out: [String: PdfValue] = [:]
        while i < end {
            i = PdfScan.skipWs(bytes, i, end)
            if PdfScan.matches(bytes, at: i, ">>") { break }
            if i >= end { break }
            if bytes[i] != 0x2F {  // '/'
                i += 1
                continue
            }
            i += 1
            let keyStart = i
            while i < end, !PdfScan.isNameDelimiter(bytes[i]) { i += 1 }
            let key = PdfScan.asciiString(bytes, keyStart, i)
            i = PdfScan.skipWs(bytes, i, end)
            if PdfScan.matches(bytes, at: i, "<<") {
                let endNested = PdfScan.findMatching(bytes, i, end, open: "<<", close: ">>")
                out[key] = .dict(parseDictionary(bytes, i, endNested + 2))
                i = endNested + 2
            } else if i < end, bytes[i] == 0x5B {  // '['
                let endArr = PdfScan.indexOf(bytes, "]", from: i, upTo: end) ?? end
                out[key] = .string(PdfScan.jsTrimAscii(bytes, i + 1, endArr))
                i = endArr + 1
            } else if i < end, bytes[i] == 0x2F {  // '/'
                i += 1
                let nameStart = i
                while i < end, !PdfScan.isNameDelimiter(bytes[i]) { i += 1 }
                out[key] = .string("/" + PdfScan.asciiString(bytes, nameStart, i))
            } else {
                let tokenStart = i
                while i < end, !PdfScan.isNameDelimiter(bytes[i]) { i += 1 }
                let token = PdfScan.jsTrimAscii(bytes, tokenStart, i)
                if PdfScan.isDigitsOnly(token) {
                    // Possible indirect reference: "<obj> <gen> R".
                    if let (genToken, consumed) = PdfScan.matchRefRest(bytes, i, end) {
                        out[key] = .ref("\(token) \(genToken)")
                        i += consumed
                    } else {
                        out[key] = .number(Double(token) ?? .nan)
                    }
                } else if PdfScan.isIntegerOrDecimalLiteral(token) {
                    out[key] = .number(Double(token) ?? .nan)
                } else {
                    out[key] = .string(token)
                }
            }
        }
        return out
    }

    /// `findPage(objects)` — the first object whose dict `Type` is `/Page`. The
    /// JS iterates `objects.values()` in insertion order; Swift dictionaries are
    /// unordered, so the page is identified by its unique `/Type /Page` (only one
    /// in a CGContext symbol PDF), making order irrelevant.
    static func findPage(_ objects: [String: PdfObject]) -> PdfObject? {
        for obj in objects.values where obj.dict["Type"]?.equals("/Page") == true {
            return obj
        }
        return nil
    }

    /// `resolveDict(value, objects)` — a `{ref}` dereferences to the target's
    /// dict; a nested dict passes through; anything else → nil.
    static func resolveDict(_ value: PdfValue?, _ objects: [String: PdfObject]) -> [String: PdfValue]? {
        switch value {
            case .ref(let ref): return objects[ref]?.dict
            case .dict(let dict): return dict
            default: return nil
        }
    }

    /// `resolveStreamObject(value, objects)` — only a `{ref}` resolves (to the
    /// full object); a literal/dict returns nil (matches JS).
    static func resolveStreamObject(_ value: PdfValue?, _ objects: [String: PdfObject]) -> PdfObject? {
        if case .ref(let ref) = value { return objects[ref] }
        return nil
    }

    /// `decodeStream(obj)` — `/FlateDecode` → inflate (zlib/RFC1950); no filter →
    /// raw bytes; any other filter → throw (JS `ParseError`).
    static func decodeStream(_ obj: PdfObject) throws -> [UInt8] {
        let stream = obj.stream ?? []
        let filter = obj.dict["Filter"]
        if filter?.equals("/FlateDecode") == true {
            guard let inflated = inflateZlib(stream) else {
                throw SymbolPdfParseError("symbol PDF: FlateDecode failed")
            }
            return inflated
        }
        if filter == nil { return stream }
        let name: String
        if case .string(let s)? = filter { name = s } else { name = "?" }
        throw SymbolPdfParseError("symbol PDF: unsupported stream filter \(name)")
    }

    // MARK: FlateDecode (zlib RFC1950 → raw DEFLATE via Compression)

    /// Inflate a zlib (RFC1950) stream: strip the 2-byte header and feed the raw
    /// DEFLATE body to `COMPRESSION_ZLIB` (which is RFC1951 raw deflate). The
    /// trailing 4-byte adler32 is ignored — `compression_stream` stops at the
    /// end of the deflate data. Returns nil on any decode error.
    static func inflateZlib(_ bytes: [UInt8]) -> [UInt8]? {
        #if canImport(Compression)
            guard bytes.count >= 2 else { return nil }
            // Strip the 2-byte zlib header. (Apple's CGPDFContext writes 78 01 / 78 9c.)
            let body = Array(bytes[2...])
            if body.isEmpty { return [] }
            return rawInflate(body)
        #else
            return nil
        #endif
    }

    #if canImport(Compression)
        private static func rawInflate(_ body: [UInt8]) -> [UInt8]? {
            var stream = compression_stream(
                dst_ptr: UnsafeMutablePointer<UInt8>(bitPattern: 1)!, dst_size: 0,
                src_ptr: UnsafePointer<UInt8>(bitPattern: 1)!, src_size: 0, state: nil)
            guard
                compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
                    == COMPRESSION_STATUS_OK
            else { return nil }
            defer { compression_stream_destroy(&stream) }

            let bufferSize = 64 * 1024
            let dst = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
            defer { dst.deallocate() }

            var output: [UInt8] = []
            return body.withUnsafeBufferPointer { src -> [UInt8]? in
                stream.src_ptr = src.baseAddress!
                stream.src_size = src.count
                let flags = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)
                while true {
                    stream.dst_ptr = dst
                    stream.dst_size = bufferSize
                    let status = compression_stream_process(&stream, flags)
                    let produced = bufferSize - stream.dst_size
                    if produced > 0 { output.append(contentsOf: UnsafeBufferPointer(start: dst, count: produced)) }
                    switch status {
                        case COMPRESSION_STATUS_OK: continue
                        case COMPRESSION_STATUS_END: return output
                        default: return nil
                    }
                }
            }
        }
    #endif
}
