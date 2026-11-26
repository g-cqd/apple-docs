import AppleDocsCore
import Crypto

/// Canonical web paths for document keys — a port of Bun's `safeWebDocKey` (`src/lib/safe-path.js`), so the
/// live server and the static export emit the same URLs and every exported file name fits the 255-byte
/// filesystem component limit.
///
/// A key segment longer than 200 UTF-8 bytes becomes its first 180 bytes (cut on a character boundary) plus
/// `~` and the first 12 hex digits of the SHA-1 of the full segment; other segments pass through.
public enum WebDocPath {
    static let maxSegmentBytes = 200
    static let truncatedSegmentBytes = 180
    static let hashHexDigits = 12

    /// The web path (`/doc/<safeKey>`) form of `key`.
    public static func safeKey(_ key: String) -> String {
        guard key.utf8.count > maxSegmentBytes else { return key }
        return key.split(separator: "/", omittingEmptySubsequences: false).map { safeSegment(String($0)) }
            .joined(separator: "/")
    }

    /// The URL path (`/doc/<key>`, site-relative) linking to `key`: ``safeKey(_:)`` with every byte outside the
    /// RFC 3986 path character set percent-encoded (`%` itself included), so keys containing `%`, `?`, `#`, or
    /// spaces round-trip through browsers and static hosts. Servers decode it exactly once.
    public static func href(_ key: String) -> String {
        "/doc/" + PercentEncoding.encode(safeKey(key), keeping: isPathSafe)
    }

    /// RFC 3986 `pchar` plus `/`: unreserved, sub-delims, `:` and `@`.
    private static func isPathSafe(_ byte: UInt8) -> Bool {
        switch byte {
            case _ where PercentEncoding.isAlphanumeric(byte): true
            case UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"), UInt8(ascii: "~"), UInt8(ascii: "/"): true
            case UInt8(ascii: "!"), UInt8(ascii: "$"), UInt8(ascii: "&"), UInt8(ascii: "'"), UInt8(ascii: "("),
                UInt8(ascii: ")"), UInt8(ascii: "*"), UInt8(ascii: "+"), UInt8(ascii: ","), UInt8(ascii: ";"),
                UInt8(ascii: "="), UInt8(ascii: ":"), UInt8(ascii: "@"):
                true
            default: false
        }
    }

    /// Whether `path` contains a hashed segment (and so needs ``resolve(_:candidates:)``).
    static func containsHashedSegment(_ path: String) -> Bool {
        path.split(separator: "/")
            .contains { segment in
                guard let tilde = segment.lastIndex(of: "~") else { return false }
                let tag = segment[segment.index(after: tilde)...]
                return tag.count == hashHexDigits && tag.allSatisfy(\.isHexDigit)
            }
    }

    /// The prefix every key mapping to `path` starts with (the path up to its first hashed segment's `~`).
    static func lookupPrefix(_ path: String) -> String {
        guard let tilde = path.firstIndex(of: "~") else { return path }
        return String(path[..<tilde])
    }

    private static func safeSegment(_ segment: String) -> String {
        guard segment.utf8.count > maxSegmentBytes else { return segment }
        let digest = Insecure.SHA1.hash(data: Array(segment.utf8))
        let hex =
            digest.map { byte in
                let text = String(byte, radix: 16)
                return text.count == 1 ? "0" + text : text
            }
            .joined()
        return truncated(segment, toBytes: truncatedSegmentBytes) + "~" + hex.prefix(hashHexDigits)
    }

    private static func truncated(_ text: String, toBytes limit: Int) -> String {
        var bytes = 0
        var out = ""
        for scalar in text.unicodeScalars {
            let size = String(scalar).utf8.count
            if bytes + size > limit { break }
            out.unicodeScalars.append(scalar)
            bytes += size
        }
        return out
    }
}
