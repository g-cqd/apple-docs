// Small helpers shared by `/api/fonts/file/:id` and `/api/fonts/family/:id.zip`: the
// extension→MIME map JS's `MIME_TYPES` table applies to served font files, and the
// `Content-Disposition: attachment` header builder (RFC 5987), a Swift port of
// `lib/http-content-disposition.js`'s `contentDispositionAttachment`.

import Foundation
import HTTPCore

/// `content-disposition` has no registered `HTTPFieldName` static (unlike `etag`/`cache-control`),
/// so it's constructed once from a literal — the same pattern Endpoints.swift's `fieldName(_:)`
/// and ADServeDSL's `adhRequestFieldName` use for a hardcoded, always-valid field-name token.
let contentDispositionFieldName = HTTPFieldName("content-disposition")!

/// The subset of JS's `MIME_TYPES` table `/api/fonts/file/:id` needs (font-file extensions only).
/// `MediaType(fileExtension:)`'s generated mime-db table doesn't carry `.ttc`/`.dfont` at all and
/// disagrees with JS on `.ttf`/`.otf` (mime-db: `font/sfnt`-family values; JS: `font/ttf`/
/// `font/otf`), so this hand-maps the same four extensions JS's route does, verbatim.
func fontFileContentType(extension ext: String) -> String {
    switch ext {
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "ttc": return "font/collection"
        default: return "application/octet-stream"  // .dfont + anything unrecognized
    }
}

/// Build a `Content-Disposition: attachment` header value that survives non-ASCII filenames and
/// quote characters per RFC 5987 — a US-ASCII `filename=` for legacy clients AND a UTF-8
/// `filename*=` (percent-encoded) for modern ones. Byte-for-byte port of
/// `contentDispositionAttachment` (lib/http-content-disposition.js).
func contentDispositionAttachment(_ filename: String) -> String {
    let trimmed = filename.trimmingCharacters(in: .whitespacesAndNewlines)
    let safe = trimmed.isEmpty ? "download" : trimmed

    var ascii = String.UnicodeScalarView()
    for scalar in safe.unicodeScalars {
        if scalar.value <= 0x1F { continue }  // CONTROL_CHARS: dropped
        if scalar == "\"" || scalar == "\\" || scalar == ";" || scalar == "," { continue }  // HEADER_UNSAFE: dropped
        if scalar.value < 0x20 || scalar.value > 0x7E {
            ascii.append("_")  // NON_PRINTABLE_ASCII: replaced
        } else {
            ascii.append(scalar)
        }
    }
    let asciiTrimmed = String(ascii).trimmingCharacters(in: .whitespacesAndNewlines)
    let asciiFinal = asciiTrimmed.isEmpty ? "download" : asciiTrimmed

    return "attachment; filename=\"\(asciiFinal)\"; filename*=UTF-8''\(percentEncodeRFC3986(safe))"
}

/// `encodeURIComponent` — the unreserved set `A-Za-z0-9-_.!~*'()` passes through; every other
/// byte becomes `%XX` (uppercase hex) over its UTF-8 bytes. Same semantics as WebRoutes.swift's
/// private `encodeURIComponent` (kept here too, rather than widened, so this file has no
/// cross-file dependency for its one use).
private func percentEncodeRFC3986(_ s: String) -> String {
    let unreserved = Set(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".utf8)
    let hex: [UInt8] = Array("0123456789ABCDEF".utf8)
    var out: [UInt8] = []
    for b in s.utf8 {
        if unreserved.contains(b) {
            out.append(b)
        } else {
            out.append(UInt8(ascii: "%"))
            out.append(hex[Int(b >> 4)])
            out.append(hex[Int(b & 0xF)])
        }
    }
    return String(decoding: out, as: UTF8.self)
}
