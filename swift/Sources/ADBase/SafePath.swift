// Corpus-key → web-path mapping. The native port of `src/lib/safe-path.js`'s
// web-key surface (the file-storage helpers `safeFilename`/`keyPath` are not
// ported — the Swift writer persists to ADDB, not per-key files).
//
// `safeWebDocKey` is the single boundary that both the live server (ad-server's
// /docs/<key>/ link emission) and the static build use, so a corpus key that
// overflows a filesystem component maps to the IDENTICAL canonical URL on both
// sides. Keys that already fit (every real doc key) pass through verbatim.

public enum SafePath {
    /// Max UTF-8 bytes a web path segment may carry before truncate-and-hash.
    /// Below the 255-byte filesystem component limit: the static build appends
    /// `/index.html` plus precompressed siblings, so 200 leaves headroom.
    public static let webSegmentMaxBytes = 200

    /// Bytes of the original segment preserved before the `~<sha1-12>` tag.
    /// 180 + 1 + 12 = 193 ≤ webSegmentMaxBytes, so a hashed segment never needs
    /// hashing again (idempotent for already-safe keys).
    private static let webSegmentTruncateBytes = 180

    /// SHA-1 hex prefix length appended when a segment is shortened.
    private static let hashPrefixLen = 12

    /// Map one URL path segment to a form that fits the filesystem component
    /// limit while staying deterministic. Segments that already fit are
    /// returned unchanged; long ones are truncated on a UTF-8 scalar boundary
    /// and tagged with a SHA-1 prefix of the FULL original segment.
    public static func safeWebSegment(_ segment: String) -> String {
        if segment.utf8.count <= webSegmentMaxBytes { return segment }
        let hash = String(Sha1.hexString(segment).prefix(hashPrefixLen))
        return "\(truncateToBytes(segment, webSegmentTruncateBytes))~\(hash)"
    }

    /// Fast check: does this corpus key need a hashed web path? Keys whose total
    /// byte length fits the threshold can't contain an oversized segment, so the
    /// hot path (350k render calls) costs one byteLength.
    public static func webKeyNeedsMapping(_ key: String) -> Bool {
        if key.utf8.count <= webSegmentMaxBytes { return false }
        return key
            .split(separator: "/", omittingEmptySubsequences: false)
            .contains { $0.utf8.count > webSegmentMaxBytes }
    }

    /// Canonical web path for a corpus key: every oversized segment is replaced
    /// by its `safeWebSegment` form, everything else passes through verbatim.
    /// Returns the key unchanged when no segment exceeds the threshold.
    public static func safeWebDocKey(_ key: String) -> String {
        if !webKeyNeedsMapping(key) { return key }
        return key
            .split(separator: "/", omittingEmptySubsequences: false)
            .map { safeWebSegment(String($0)) }
            .joined(separator: "/")
    }

    /// Reject storage keys that would escape `dataDir` via traversal segments
    /// (`..`), absolute roots (`/`, `~`, `C:\`), embedded NULs, or backslash
    /// separators. Throws on the first violation; returns the key on success so
    /// callers can chain. Port of `validateStorageKey`.
    @discardableResult
    public static func validateStorageKey(_ rawKey: String) throws -> String {
        if rawKey.isEmpty {
            throw SafePathError.emptyKey
        }
        if rawKey.hasPrefix("/") || rawKey.hasPrefix("~") {
            throw SafePathError.absoluteKey(rawKey)
        }
        if isWindowsRoot(rawKey) {
            throw SafePathError.windowsRoot(rawKey)
        }
        for seg in rawKey.split(separator: "/", omittingEmptySubsequences: false) {
            if seg.isEmpty || seg == "." || seg == ".." {
                throw SafePathError.invalidSegment(String(seg), key: rawKey)
            }
            // Backslashes are a smuggling vector when a key is later read by
            // Windows code or normalized by a tool; NUL terminates C strings.
            // Compare on UTF-8 bytes: 0x5C = '\\', 0x00 = NUL.
            if seg.utf8.contains(0x5C) || seg.utf8.contains(0) {
                throw SafePathError.forbiddenCharacter(rawKey)
            }
        }
        return rawKey
    }

    /// Truncate to at most `maxBytes` UTF-8 bytes without slicing across a
    /// Unicode scalar boundary (matching JS `for…of` code-point iteration).
    static func truncateToBytes(_ str: String, _ maxBytes: Int) -> String {
        if str.utf8.count <= maxBytes { return str }
        var bytes = 0
        var out = String.UnicodeScalarView()
        for scalar in str.unicodeScalars {
            let scalarBytes = String(scalar).utf8.count
            if bytes + scalarBytes > maxBytes { break }
            out.append(scalar)
            bytes += scalarBytes
        }
        return String(out)
    }

    /// `^[A-Za-z]:[\\/]` — a Windows drive root.
    private static func isWindowsRoot(_ s: String) -> Bool {
        let scalars = Array(s.unicodeScalars.prefix(3))
        guard scalars.count == 3 else { return false }
        let v = scalars[0].value
        let isLetter = (v >= 65 && v <= 90) || (v >= 97 && v <= 122)
        return isLetter && scalars[1] == ":" && (scalars[2] == "\\" || scalars[2] == "/")
    }
}

/// Validation failures from `SafePath.validateStorageKey` (the JS `ValidationError`).
public enum SafePathError: Error, Equatable, Sendable {
    case emptyKey
    case absoluteKey(String)
    case windowsRoot(String)
    case invalidSegment(String, key: String)
    case forbiddenCharacter(String)
}
