// Byte-exact Swift port of the JS SF-Symbol PDF→SVG converter
// (src/resources/symbol-pdf-to-svg.js + its three submodules). The JS oracle is
// authoritative: `render_sf_symbol`'s gated parity test compares this output,
// byte-for-byte, against `symbolPdfToSvg(nativeSymbolPdf(...))`. Because the
// native `ADRender.SymbolPdf.render` already emits PDF bytes identical to the JS
// `nativeSymbolPdf` (proven by render-parity.test.js), the only thing that must
// match here is the conversion.
//
// Structure mirrors the JS file-for-file:
//   - PdfObjects      ← symbol-pdf-to-svg/pdf-objects.js (object graph, FlateDecode)
//   - ContentStream   ← symbol-pdf-to-svg/content-stream.js (operator interpreter)
//   - SvgEmit         ← symbol-pdf-to-svg/svg-emit.js (luminance-mask compositor)
//   - SymbolPdfToSvg.convert(_:options:) ← symbol-pdf-to-svg.js facade
//
// Everything operates on raw bytes (the JS `bytesToLatin1` round-trip maps every
// byte 1:1 to a char in U+0000…U+00FF, so a `[UInt8]` view is equivalent and
// avoids any encoding ambiguity). Number/coordinate formatting and the FNV-1a
// mask-id hashing reproduce the JS string production exactly.

import Foundation

#if canImport(Compression)
    import Compression
#endif

// MARK: - Errors

/// Mirrors the JS `ParseError` thrown by the converter — the caller maps any
/// throw to the same "this symbol can't be converted" outcome the JS path has
/// (the spawn/fallback in JS; a tool failure → self-skip here).
struct SymbolPdfParseError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: - Public facade (symbol-pdf-to-svg.js)

enum SymbolPdfToSvg {
    /// Options for the converter, matching the JS `opts` bag
    /// (`{ name, pointSize, color, background }`) with the JS defaults applied at
    /// the `assembleSvg` boundary (name "", pointSize 128, color "currentColor",
    /// background nil).
    struct Options {
        var name: String
        var pointSize: Int
        var color: String
        var background: String?

        init(name: String = "", pointSize: Int = 128, color: String = "currentColor", background: String? = nil) {
            self.name = name
            self.pointSize = pointSize
            self.color = color
            self.background = background
        }
    }

    /// `symbolPdfToSvg(pdfBytes, opts)` — parse the single-page symbol PDF and
    /// emit a luminance-mask SVG. Throws `SymbolPdfParseError` on the same
    /// conditions the JS facade throws `ParseError`.
    static func convert(_ pdfBytes: [UInt8], options: Options) throws -> String {
        let objects = PdfObjects.collectObjects(pdfBytes)
        guard let page = PdfObjects.findPage(objects) else {
            throw SymbolPdfParseError("symbol PDF: no /Type /Page object found")
        }
        let resources = PdfObjects.resolveDict(page.dict["Resources"], objects)
        let extGState = PdfObjects.resolveDict(resources?["ExtGState"], objects) ?? [:]
        // alphaByName: ExtGState name → ca (parsed as a JS Number.parseFloat).
        var alphaByName: [String: Double] = [:]
        for (name, ref) in extGState {
            guard let dict = PdfObjects.resolveDict(ref, objects) else { continue }
            if let ca = dict["ca"], let value = ca.asParsedFloat { alphaByName[name] = value }
        }
        let contentRef = page.dict["Contents"]
        guard let contentObj = PdfObjects.resolveStreamObject(contentRef, objects) else {
            throw SymbolPdfParseError("symbol PDF: no content stream")
        }
        let stream = try PdfObjects.decodeStream(contentObj)
        let fills = ContentStream.parse(stream, alphaByName: alphaByName)
        if fills.isEmpty { throw SymbolPdfParseError("symbol PDF: no fill operations") }
        return try SvgEmit.assemble(fills, options: options)
    }
}

// MARK: - PDF values

/// A parsed PDF dictionary value, covering exactly the shapes the JS
/// `parseDictionary` produces for CGContext-emitted symbol PDFs: a number, a
/// "string" (a `/Name`, a bare token, or the trimmed contents of a `[...]`
/// array), an indirect reference (`{ ref: "n g" }`), or a nested dictionary.
enum PdfValue {
    case number(Double)
    case string(String)
    case ref(String)
    case dict([String: PdfValue])

    /// JS `value === '/Page'`-style equality: true only for a `.string` whose
    /// text matches exactly.
    func equals(_ other: String) -> Bool {
        if case .string(let s) = self { return s == other }
        return false
    }

    /// `Number.parseFloat(value)` — a `.number` passes through (when finite);
    /// a `.string` parses its leading numeric run (JS lenient parse). Anything
    /// else, or a non-numeric string, is nil (the JS `undefined`/`NaN` path).
    var asParsedFloat: Double? {
        switch self {
            case .number(let n): return n.isFinite ? n : nil
            case .string(let s): return jsParseFloat(s)
            default: return nil
        }
    }
}

/// One indexed `n g obj … endobj` block: its parsed dictionary and (for a
/// stream object) the raw, still-compressed payload bytes.
struct PdfObject {
    let id: String
    var dict: [String: PdfValue]
    var stream: [UInt8]?
}

// MARK: - PDF object graph (pdf-objects.js)

enum PdfObjects {
    /// `collectObjects(text, bytes)` — two-pass extraction. Pass 1 indexes every
    /// `n g obj … endobj` block (parsing the leading dictionary, recording any
    /// stream byte range); pass 2 slices each stream now that indirect `/Length`
    /// refs can be resolved. Works directly on the bytes (the JS latin-1 string
    /// is a 1:1 byte view).
    static func collectObjects(_ bytes: [UInt8]) -> [String: PdfObject] {
        let n = bytes.count
        // Records mirror the JS `records` array (id, dict, optional stream range).
        struct StreamRange {
            let absStart: Int
            let endObj: Int  // absolute index of "endobj" (== headerEnd + body length)
            let headerEnd: Int
            let streamStart: Int  // index of "stream" within body
        }
        struct Record {
            let id: String
            let dict: [String: PdfValue]
            let range: StreamRange?
        }
        var records: [Record] = []

        // /(\d+)\s+(\d+)\s+obj\b/g over the bytes.
        var i = 0
        while i < n {
            // Find the next digit run that begins an "<int> <int> obj" header.
            guard let d1 = nextDigitStart(bytes, from: i) else { break }
            var p = d1
            while p < n, isDigit(bytes[p]) { p += 1 }
            let num1End = p
            // \s+
            guard p < n, isPdfWhitespace(bytes[p]) else {
                i = num1End
                continue
            }
            while p < n, isPdfWhitespace(bytes[p]) { p += 1 }
            // (\d+)
            let d2 = p
            while p < n, isDigit(bytes[p]) { p += 1 }
            guard p > d2 else {
                i = num1End
                continue
            }
            let num2End = p  // capture before the trailing-whitespace skip (else the id gets a stray space)
            // \s+
            guard p < n, isPdfWhitespace(bytes[p]) else {
                i = num1End
                continue
            }
            while p < n, isPdfWhitespace(bytes[p]) { p += 1 }
            // obj\b
            guard matches(bytes, at: p, "obj"), isWordBoundaryAfter(bytes, p + 3) else {
                i = num1End
                continue
            }
            let id = "\(asciiString(bytes, d1, num1End)) \(asciiString(bytes, d2, num2End))"
            let headerEnd = p + 3
            guard let endObj = indexOf(bytes, "endobj", from: headerEnd) else {
                // No endobj: JS `continue`s without recording; advance past header.
                i = headerEnd
                continue
            }
            // body = bytes[headerEnd ..< endObj]; streamStart relative to body.
            let streamStartRel = indexOf(bytes, "stream", from: headerEnd, upTo: endObj)
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
            records.append(Record(id: id, dict: dict, range: range))
            i = endObj + 6  // past "endobj"
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
            let literalLength = resolveStreamLength(r.dict["Length"], bytes)
            let absEnd: Int
            if let literalLength {
                absEnd = range.absStart + literalLength
            } else {
                // Fallback: scan to "endstream" within the body, trimming trailing newlines.
                let endStreamRel =
                    indexOf(bytes, "endstream", from: range.headerEnd + range.streamStart)
                    .map { $0 - range.headerEnd } ?? (range.endObj - range.headerEnd)
                var e = range.headerEnd + endStreamRel
                while e > range.absStart && (bytes[e - 1] == 0x0A || bytes[e - 1] == 0x0D) { e -= 1 }
                absEnd = e
            }
            let clampedEnd = max(range.absStart, min(absEnd, n))
            objects[r.id]?.stream = Array(bytes[range.absStart ..< clampedEnd])
        }
        return objects
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
            let precededByWs = i > 0 && isPdfWhitespace(bytes[i - 1])
            guard atStart || precededByWs else {
                i += 1
                continue
            }
            var p = i
            guard matches(bytes, at: p, objBytes) else {
                i += 1
                continue
            }
            p += objBytes.count
            guard p < n, isPdfWhitespace(bytes[p]) else {
                i += 1
                continue
            }
            while p < n, isPdfWhitespace(bytes[p]) { p += 1 }
            guard matches(bytes, at: p, genBytes) else {
                i += 1
                continue
            }
            p += genBytes.count
            guard p < n, isPdfWhitespace(bytes[p]) else {
                i += 1
                continue
            }
            while p < n, isPdfWhitespace(bytes[p]) { p += 1 }
            guard matches(bytes, at: p, "obj"), isWordBoundaryAfter(bytes, p + 3) else {
                i += 1
                continue
            }
            let headerEnd = p + 3
            guard let endObj = indexOf(bytes, "endobj", from: headerEnd) else { return nil }
            let inner = jsTrimAscii(bytes, headerEnd, endObj)
            guard isIntegerOrDecimalLiteral(inner) else { return nil }
            return Double(inner).flatMap { $0.isFinite ? Int($0) : nil }
        }
        return nil
    }

    /// `parseDictionary(text)` — the minimal `<<…>>` parser. Returns the entries
    /// in the JS dict shape; only the slice `bytes[start..<end]` is considered.
    static func parseDictionary(_ bytes: [UInt8], _ start: Int, _ end: Int) -> [String: PdfValue] {
        guard let dictStart = indexOf(bytes, "<<", from: start, upTo: end) else { return [:] }
        var i = dictStart + 2
        var out: [String: PdfValue] = [:]
        while i < end {
            i = skipWs(bytes, i, end)
            if matches(bytes, at: i, ">>") { break }
            if i >= end { break }
            if bytes[i] != 0x2F {  // '/'
                i += 1
                continue
            }
            i += 1
            let keyStart = i
            while i < end, !isNameDelimiter(bytes[i]) { i += 1 }
            let key = asciiString(bytes, keyStart, i)
            i = skipWs(bytes, i, end)
            if matches(bytes, at: i, "<<") {
                let endNested = findMatching(bytes, i, end, open: "<<", close: ">>")
                out[key] = .dict(parseDictionary(bytes, i, endNested + 2))
                i = endNested + 2
            } else if i < end, bytes[i] == 0x5B {  // '['
                let endArr = indexOf(bytes, "]", from: i, upTo: end) ?? end
                out[key] = .string(jsTrimAscii(bytes, i + 1, endArr))
                i = endArr + 1
            } else if i < end, bytes[i] == 0x2F {  // '/'
                i += 1
                let nameStart = i
                while i < end, !isNameDelimiter(bytes[i]) { i += 1 }
                out[key] = .string("/" + asciiString(bytes, nameStart, i))
            } else {
                let tokenStart = i
                while i < end, !isNameDelimiter(bytes[i]) { i += 1 }
                let token = jsTrimAscii(bytes, tokenStart, i)
                if isDigitsOnly(token) {
                    // Possible indirect reference: "<obj> <gen> R".
                    if let (genToken, consumed) = matchRefRest(bytes, i, end) {
                        out[key] = .ref("\(token) \(genToken)")
                        i += consumed
                    } else {
                        out[key] = .number(Double(token) ?? .nan)
                    }
                } else if isIntegerOrDecimalLiteral(token) {
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

// MARK: - Content stream (content-stream.js)

/// One path command: an operator letter (`M`/`L`/`C`/`Z`) and its flipped-later
/// coordinate args (`Z` carries none).
struct PathCommand {
    let op: String
    let args: [Double]
}

/// A subpath = an ordered command list (starts with `M`).
struct Subpath {
    var commands: [PathCommand]
}

/// A fill record: its subpaths, the alpha in force when it was painted, and the
/// fill rule (`nonzero`/`evenodd`).
struct Fill {
    var subpaths: [Subpath]
    let alpha: Double
    let fillRule: String
}

enum ContentStream {
    private enum Operand {
        case number(Double)
        case name(String)
    }
    private enum Token {
        case number(Double)
        case name(String)
        case op(String)
    }

    /// `parseContentStream(buffer, alphaByName)` — interpret the CGContext-shaped
    /// operator subset into a flat list of fills.
    static func parse(_ buffer: [UInt8], alphaByName: [String: Double]) -> [Fill] {
        let tokens = tokenize(buffer)
        var operands: [Operand] = []
        var fills: [Fill] = []
        var path: [Subpath] = []
        var currentX = 0.0
        var currentY = 0.0
        var stack: [Double] = [1.0]  // alpha stack; top() is last

        func topAlpha() -> Double { stack[stack.count - 1] }
        func setTopAlpha(_ value: Double) { stack[stack.count - 1] = value }

        func num(_ i: Int) -> Double {
            guard i >= 0, i < operands.count, case .number(let n) = operands[i] else { return .nan }
            return n
        }

        func closeFill(_ fillRule: String) {
            if path.isEmpty { return }
            fills.append(Fill(subpaths: path, alpha: topAlpha(), fillRule: fillRule))
            path = []
        }
        func startSubpath(_ x: Double, _ y: Double) {
            path.append(Subpath(commands: [PathCommand(op: "M", args: [x, y])]))
            currentX = x
            currentY = y
        }
        func appendCommand(_ cmd: PathCommand) {
            if path.isEmpty { return }
            path[path.count - 1].commands.append(cmd)
        }

        for token in tokens {
            switch token {
                case .number(let n):
                    operands.append(.number(n))
                    continue
                case .name(let value):
                    operands.append(.name(value))
                    continue
                case .op(let op):
                    switch op {
                        case "q":
                            stack.append(topAlpha())
                        case "Q":
                            if stack.count > 1 { stack.removeLast() }
                        case "gs":
                            if case .name(let name)? = operands.first, name.hasPrefix("/") {
                                let key = String(name.dropFirst())
                                if let alpha = alphaByName[key] { setTopAlpha(alpha) }
                            }
                        case "cm":
                            break
                        case "cs", "sc", "scn", "CS", "SC", "SCN", "rg", "RG", "g", "G", "k", "K":
                            break
                        case "m":
                            startSubpath(num(0), num(1))
                        case "l":
                            appendCommand(PathCommand(op: "L", args: [num(0), num(1)]))
                            currentX = num(0)
                            currentY = num(1)
                        case "c":
                            appendCommand(
                                PathCommand(op: "C", args: [num(0), num(1), num(2), num(3), num(4), num(5)]))
                            currentX = num(4)
                            currentY = num(5)
                        case "v":
                            appendCommand(
                                PathCommand(
                                    op: "C", args: [currentX, currentY, num(0), num(1), num(2), num(3)]))
                            currentX = num(2)
                            currentY = num(3)
                        case "y":
                            appendCommand(
                                PathCommand(op: "C", args: [num(0), num(1), num(2), num(3), num(2), num(3)]))
                            currentX = num(2)
                            currentY = num(3)
                        case "re":
                            let x = num(0)
                            let y = num(1)
                            let w = num(2)
                            let h = num(3)
                            path.append(
                                Subpath(commands: [
                                    PathCommand(op: "M", args: [x, y]),
                                    PathCommand(op: "L", args: [x + w, y]),
                                    PathCommand(op: "L", args: [x + w, y + h]),
                                    PathCommand(op: "L", args: [x, y + h]),
                                    PathCommand(op: "Z", args: [])
                                ]))
                            currentX = x
                            currentY = y
                        case "h":
                            appendCommand(PathCommand(op: "Z", args: []))
                        case "f", "F", "f*":
                            closeFill(op == "f*" ? "evenodd" : "nonzero")
                        case "B", "B*", "b", "b*":
                            if op == "b" || op == "b*" { appendCommand(PathCommand(op: "Z", args: [])) }
                            closeFill(op.contains("*") ? "evenodd" : "nonzero")
                        case "n", "S", "s":
                            path = []
                        default:
                            break
                    }
                    operands.removeAll(keepingCapacity: true)
            }
        }
        return fills
    }

    /// `tokenize(text)` — the JS content-stream tokenizer. Number tokens use JS
    /// `Number(slice)` (non-finite → an op token of the raw slice).
    private static func tokenize(_ bytes: [UInt8]) -> [Token] {
        var tokens: [Token] = []
        var i = 0
        let n = bytes.count
        while i < n {
            let ch = bytes[i]
            if ch == 0x25 {  // '%'
                if let nl = indexOf(bytes, "\n", from: i) {
                    i = nl + 1
                } else {
                    i = n
                }
                continue
            }
            if isPdfWhitespace(ch) {
                i += 1
                continue
            }
            if ch == 0x2F {  // '/'
                let start = i
                i += 1
                while i < n, !isTokenNameDelimiter(bytes[i]) { i += 1 }
                tokens.append(.name(asciiString(bytes, start, i)))
                continue
            }
            if ch == 0x2D || ch == 0x2E || isDigit(ch) {  // '-' '.' or digit
                let start = i
                i += 1
                while i < n, isNumberByte(bytes[i]) { i += 1 }
                let slice = asciiString(bytes, start, i)
                if let value = Double(slice), value.isFinite {
                    tokens.append(.number(value))
                } else {
                    tokens.append(.op(slice))
                }
                continue
            }
            if isAlpha(ch) || ch == 0x2A || ch == 0x27 || ch == 0x22 {  // A-Za-z * ' "
                let start = i
                i += 1
                while i < n, isOpByte(bytes[i]) { i += 1 }
                tokens.append(.op(asciiString(bytes, start, i)))
                continue
            }
            i += 1
        }
        return tokens
    }
}

// MARK: - Content-stream byte classes

/// `[A-Za-z]`.
private func isAlpha(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) }

/// Name delimiter in the content tokenizer: `/[\s/[\](){}<>]/` — note this set
/// adds `(`, `)`, `{`, `}` over the dictionary parser's class.
private func isTokenNameDelimiter(_ b: UInt8) -> Bool {
    if isPdfWhitespace(b) { return true }
    switch b {
        case 0x2F, 0x5B, 0x5D, 0x28, 0x29, 0x7B, 0x7D, 0x3C, 0x3E: return true  // / [ ] ( ) { } < >
        default: return false
    }
}

/// Number-continuation class `/[0-9.\-+eE]/`.
private func isNumberByte(_ b: UInt8) -> Bool {
    isDigit(b) || b == 0x2E || b == 0x2D || b == 0x2B || b == 0x65 || b == 0x45  // . - + e E
}

/// Operator-continuation class `/[A-Za-z0-9*'"]/`.
private func isOpByte(_ b: UInt8) -> Bool {
    isAlpha(b) || isDigit(b) || b == 0x2A || b == 0x27 || b == 0x22  // * ' "
}

// MARK: - Byte-scan helpers (mirror the JS regex/string ops)

/// `[0-9]` (JS `\d`).
private func isDigit(_ b: UInt8) -> Bool { b >= 0x30 && b <= 0x39 }

/// JS `\s` restricted to the bytes reachable in a latin-1 view: \t \n \v \f \r
/// space, plus NBSP (0xA0). Every place the JS converter writes `\s` / `[\s…]`
/// uses this set (the PDF header regex, skipWs, name/token delimiters).
private func isPdfWhitespace(_ b: UInt8) -> Bool {
    switch b {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0: return true
        default: return false
    }
}

/// JS name/token delimiter class `/[\s/<>[\]]/`.
private func isNameDelimiter(_ b: UInt8) -> Bool {
    if isPdfWhitespace(b) { return true }
    switch b {
        case 0x2F, 0x3C, 0x3E, 0x5B, 0x5D: return true  // / < > [ ]
        default: return false
    }
}

/// `\w` = `[A-Za-z0-9_]`; a `\b` after an `obj` token means the next byte is
/// NOT a word char (or we're at end-of-input).
private func isWordChar(_ b: UInt8) -> Bool {
    (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || isDigit(b) || b == 0x5F
}
private func isWordBoundaryAfter(_ bytes: [UInt8], _ index: Int) -> Bool {
    index >= bytes.count || !isWordChar(bytes[index])
}

/// The next index ≥ from that begins a digit run.
private func nextDigitStart(_ bytes: [UInt8], from: Int) -> Int? {
    var i = max(0, from)
    while i < bytes.count {
        if isDigit(bytes[i]) { return i }
        i += 1
    }
    return nil
}

/// `text.startsWith(needle, at)` for a byte needle.
private func matches(_ bytes: [UInt8], at index: Int, _ needle: [UInt8]) -> Bool {
    guard index >= 0, index + needle.count <= bytes.count else { return false }
    for k in 0 ..< needle.count where bytes[index + k] != needle[k] { return false }
    return true
}
private func matches(_ bytes: [UInt8], at index: Int, _ needle: String) -> Bool {
    matches(bytes, at: index, Array(needle.utf8))
}

/// `text.indexOf(needle, from)` (optionally bounded by `upTo`, exclusive),
/// returning the absolute index or nil.
private func indexOf(_ bytes: [UInt8], _ needle: String, from: Int, upTo: Int? = nil) -> Int? {
    let needleBytes = Array(needle.utf8)
    if needleBytes.isEmpty { return from }
    let limit = (upTo ?? bytes.count) - needleBytes.count
    var i = max(0, from)
    while i <= limit {
        if matches(bytes, at: i, needleBytes) { return i }
        i += 1
    }
    return nil
}

/// `String.fromCharCode` over an ASCII byte range — these slices are object ids
/// / dict keys / numeric tokens (all ASCII in CGContext PDFs).
private func asciiString(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
    guard start < end, start >= 0, end <= bytes.count else { return "" }
    return String(decoding: bytes[start ..< end], as: UTF8.self)
}

/// `skipWs(text, i)` — advance over JS `\s`.
private func skipWs(_ bytes: [UInt8], _ start: Int, _ end: Int) -> Int {
    var i = start
    while i < end, isPdfWhitespace(bytes[i]) { i += 1 }
    return i
}

/// `findMatching(text, start, open, close)` — balanced `<<`/`>>` matching; the
/// JS fallback when unbalanced is `text.length - close.length`.
private func findMatching(_ bytes: [UInt8], _ start: Int, _ end: Int, open: String, close: String) -> Int {
    let openBytes = Array(open.utf8)
    let closeBytes = Array(close.utf8)
    var depth = 1
    var i = start + openBytes.count
    while i < end, depth > 0 {
        if matches(bytes, at: i, openBytes) {
            depth += 1
            i += openBytes.count
        } else if matches(bytes, at: i, closeBytes) {
            depth -= 1
            if depth == 0 { return i }
            i += closeBytes.count
        } else {
            i += 1
        }
    }
    return end - closeBytes.count
}

/// `String.prototype.trim()` over an ASCII byte range. JS `trim` strips the same
/// `\s` set as above plus line terminators; for ASCII tokens this is the JS `\s`
/// set, applied at both ends.
private func jsTrimAscii(_ bytes: [UInt8], _ start: Int, _ end: Int) -> String {
    var s = max(0, start)
    var e = min(bytes.count, end)
    while s < e, isPdfWhitespace(bytes[s]) { s += 1 }
    while e > s, isPdfWhitespace(bytes[e - 1]) { e -= 1 }
    return asciiString(bytes, s, e)
}

/// `/^(\d+)$/` — all ASCII digits, non-empty.
private func isDigitsOnly(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    guard !bytes.isEmpty else { return false }
    return bytes.allSatisfy { isDigit($0) }
}

/// `/^-?\d+(?:\.\d+)?$/` — an optional leading `-`, integer digits, optional
/// `.` + fractional digits.
private func isIntegerOrDecimalLiteral(_ s: String) -> Bool {
    let bytes = Array(s.utf8)
    var i = 0
    let n = bytes.count
    guard n > 0 else { return false }
    if bytes[i] == 0x2D { i += 1 }  // '-'
    let intStart = i
    while i < n, isDigit(bytes[i]) { i += 1 }
    guard i > intStart else { return false }
    if i < n {
        guard bytes[i] == 0x2E else { return false }  // '.'
        i += 1
        let fracStart = i
        while i < n, isDigit(bytes[i]) { i += 1 }
        guard i > fracStart else { return false }
    }
    return i == n
}

/// `after.match(/^\s+(\d+)\s+R\b/)` starting at byte `index`: returns the gen
/// digit string and the number of bytes consumed (the whole match length), or
/// nil when the indirect-reference tail isn't present.
private func matchRefRest(_ bytes: [UInt8], _ index: Int, _ end: Int) -> (gen: String, consumed: Int)? {
    var p = index
    let wsStart = p
    while p < end, isPdfWhitespace(bytes[p]) { p += 1 }
    guard p > wsStart else { return nil }  // \s+ requires ≥1
    let genStart = p
    while p < end, isDigit(bytes[p]) { p += 1 }
    guard p > genStart else { return nil }  // \d+
    let gen = asciiString(bytes, genStart, p)
    let ws2 = p
    while p < end, isPdfWhitespace(bytes[p]) { p += 1 }
    guard p > ws2 else { return nil }  // \s+
    guard p < end, bytes[p] == 0x52, isWordBoundaryAfter(bytes, p + 1) else { return nil }  // 'R' \b
    p += 1
    return (gen, p - index)
}

/// `Number.parseFloat(s)` — parse the leading numeric run of a string, ignoring
/// leading whitespace, returning nil when no numeric prefix exists. Matches the
/// JS lenient float parse (used only for ExtGState `ca` string values).
private func jsParseFloat(_ s: String) -> Double? {
    let chars = Array(s.unicodeScalars)
    let n = chars.count
    func isAsciiDigit(_ u: Unicode.Scalar) -> Bool { u.value >= 0x30 && u.value <= 0x39 }
    var i = 0
    while i < n, chars[i] == " " || chars[i] == "\t" || chars[i] == "\n" || chars[i] == "\r" { i += 1 }
    var j = i
    if j < n, chars[j] == "+" || chars[j] == "-" { j += 1 }
    var sawDigit = false
    while j < n, isAsciiDigit(chars[j]) {
        j += 1
        sawDigit = true
    }
    if j < n, chars[j] == "." {
        j += 1
        while j < n, isAsciiDigit(chars[j]) {
            j += 1
            sawDigit = true
        }
    }
    if j < n, chars[j] == "e" || chars[j] == "E" {
        var k = j + 1
        if k < n, chars[k] == "+" || chars[k] == "-" { k += 1 }
        var expDigit = false
        while k < n, isAsciiDigit(chars[k]) {
            k += 1
            expDigit = true
        }
        if expDigit { j = k }
    }
    guard sawDigit else { return nil }
    return Double(String(String.UnicodeScalarView(chars[i ..< j])))
}

// MARK: - SvgEmit (svg-emit.js)

/// Compose the parsed fills into a luminance-mask SVG mirroring Apple's
/// destination-out compositing (alpha-0 fills carve earlier layers via `<mask>`).
/// Byte-for-byte equal to `assembleSvg` — same number formatting, FNV-1a mask ids,
/// attribute order, and whitespace.
enum SvgEmit {
    static func assemble(_ fills: [Fill], options: SymbolPdfToSvg.Options) throws -> String {
        var minX = Double.infinity
        var maxX = -Double.infinity
        var minY = Double.infinity
        var maxY = -Double.infinity
        for fill in fills {
            for sub in fill.subpaths {
                for cmd in sub.commands {
                    if cmd.args.isEmpty { continue }  // JS `if (!cmd.args) continue` (Z has none)
                    var i = 0
                    while i < cmd.args.count {
                        let x = cmd.args[i]
                        if x < minX { minX = x }
                        if x > maxX { maxX = x }
                        if i + 1 < cmd.args.count {
                            let y = cmd.args[i + 1]
                            if y < minY { minY = y }
                            if y > maxY { maxY = y }
                        }
                        i += 2
                    }
                }
            }
        }
        if !minX.isFinite { throw SymbolPdfParseError("symbol PDF: empty geometry") }
        let spanRaw = max(maxX - minX, maxY - minY)
        let span = spanRaw == 0 ? 1 : spanRaw
        let pad = span * 0.06
        func flipY(_ y: Double) -> Double { maxY - y + pad }
        func flipX(_ x: Double) -> Double { x - minX + pad }
        let vbW = maxX - minX + pad * 2
        let vbH = maxY - minY + pad * 2

        let fillColor = options.color
        let escapedName = escapeXml(options.name)
        let ds = fills.map { subpathsToD($0.subpaths, flipX, flipY) }
        let idBase =
            "c" + fnv1a("\(options.name)|\(jsNumberString(vbW))x\(jsNumberString(vbH))|\(ds.joined(separator: "|"))")
        var defs = ""
        var nodes: [String] = []
        for (idx, fill) in fills.enumerated() {
            if fill.alpha > 0 {
                let ruleAttr = fillRuleAttr(fill.fillRule)
                nodes.append("<path d=\"\(ds[idx])\" fill=\"\(fillColor)\"\(ruleAttr)/>")
            } else {
                if nodes.isEmpty { continue }
                let maskId = "\(idBase)_\(idx)"
                let cutD = ds[idx]
                defs +=
                    "<mask id=\"\(maskId)\" maskUnits=\"userSpaceOnUse\" x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" mask-type=\"luminance\" style=\"mask-type:luminance\">"
                    + "<rect x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" fill=\"#fff\"/>"
                    + "<path d=\"\(cutD)\" fill=\"#000\"\(fillRuleAttr(fill.fillRule))/>"
                    + "</mask>"
                nodes = ["<g mask=\"url(#\(maskId))\">\(nodes.joined())</g>"]
            }
        }
        let body = nodes.joined()
        let bgRect: String
        if let background = options.background {
            bgRect =
                "<rect x=\"0\" y=\"0\" width=\"\(formatNumber(vbW))\" height=\"\(formatNumber(vbH))\" fill=\"\(escapeXml(background))\"/>"
        } else {
            bgRect = ""
        }
        let defsBlock = defs.isEmpty ? "" : "<defs>\(defs)</defs>"
        let viewBox = "0 0 \(formatNumber(vbW)) \(formatNumber(vbH))"
        return
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"\(options.pointSize)\" height=\"\(options.pointSize)\" viewBox=\"\(viewBox)\" role=\"img\" aria-label=\"\(escapedName)\">\(defsBlock)\(bgRect)\(body)</svg>"
    }

    private static func subpathsToD(_ subpaths: [Subpath], _ flipX: (Double) -> Double, _ flipY: (Double) -> Double)
        -> String
    {
        var parts: [String] = []
        for sub in subpaths {
            for cmd in sub.commands {
                if cmd.op == "Z" {
                    parts.append("Z")
                    continue
                }
                var args = cmd.args
                var i = 0
                while i < args.count {
                    args[i] = flipX(args[i])
                    if i + 1 < args.count { args[i + 1] = flipY(args[i + 1]) }
                    i += 2
                }
                parts.append(cmd.op + args.map(formatNumber).joined(separator: " "))
            }
        }
        return parts.joined(separator: " ")
    }

    private static func fnv1a(_ str: String) -> String {
        var h: UInt32 = 0x811c_9dc5
        for scalar in str.unicodeScalars {
            h ^= UInt32(scalar.value & 0xFFFF)  // JS charCodeAt = UTF-16 code unit (BMP here)
            h = h &* 0x0100_0193
        }
        return String(h, radix: 36)
    }

    /// JS `n.toFixed(3)` then `replace(/\.?0+$/, '') || '0'`. The geometry is
    /// normalised to non-negative coords, so sign handling is unneeded.
    static func formatNumber(_ n: Double) -> String {
        if !n.isFinite { return "0" }
        var s = String(format: "%.3f", n)
        if s.contains(".") {
            while s.hasSuffix("0") { s.removeLast() }
            if s.hasSuffix(".") { s.removeLast() }
        }
        return s.isEmpty ? "0" : s
    }

    /// JS default `Number → String` for vbW/vbH inside the fnv1a hash input. Only
    /// affects cut-out symbols' mask ids (not the gated square.grid.2x2 path).
    private static func jsNumberString(_ n: Double) -> String {
        if n == n.rounded(), abs(n) < 1e21 { return String(Int64(n)) }
        var s = String(n)
        if s.hasSuffix(".0") { s.removeLast(2) }
        return s
    }

    private static func fillRuleAttr(_ rule: String) -> String { rule == "evenodd" ? " fill-rule=\"evenodd\"" : "" }

    static func escapeXml(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.count)
        for ch in value {
            switch ch {
                case "<": out += "&lt;"
                case ">": out += "&gt;"
                case "&": out += "&amp;"
                case "\"": out += "&quot;"
                case "'": out += "&apos;"
                default: out.append(ch)
            }
        }
        return out
    }
}
