import Crypto
import Foundation

// Storage-key → raw-json path mapping (lib/safe-path.js) and tag-derived determinism (snapshot.js):
// deterministic createdAt / mtime + filename safety. Split from Snapshot.swift to keep the enum
// body within the size/complexity gate.
extension Snapshot {
    // MARK: - storage key → raw-json path (mirrors lib/safe-path.js keyPath)

    /// `keyPath(dataDir, subdir, key, ext)` (lib/safe-path.js): split the key into
    /// directory segments + a leaf, map the leaf through ``safeFilename`` (long
    /// Apple symbol names get truncated + SHA-1-tagged), and join under `subdir`.
    /// nil when the key fails ``isValidStorageKey`` (traversal / absolute /
    /// forbidden char). Public: the read-side lookup (ad-cli `read`) resolves the
    /// persisted `markdown/<key>.md` render through the same mapping the writer
    /// used, so reads and writes always agree on the on-disk path.
    public static func storageKeyPath(dataDir: String, subdir: String, key: String, ext: String) -> String? {
        guard isValidStorageKey(key) else { return nil }
        var segments = key.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        let basename = segments.popLast() ?? ""
        let safe = safeFilename(basename: basename, ext: ext)
        return ([dataDir, subdir] + segments + [safe]).joined(separator: "/")
    }

    /// `keyPath(dataDir, 'raw-json', key, '.json')` — the writer's raw-payload path.
    static func rawJsonPath(dataDir: String, key: String) -> String? {
        storageKeyPath(dataDir: dataDir, subdir: "raw-json", key: key, ext: ".json")
    }

    /// `validateStorageKey` as a predicate: non-empty, relative (no `/`/`~`/`A:\`
    /// root), and every `/`-segment is a real name (not `''`/`.`/`..`, no `\`/NUL).
    static func isValidStorageKey(_ key: String) -> Bool {
        guard !key.isEmpty, !key.hasPrefix("/"), !key.hasPrefix("~") else { return false }
        let chars = Array(key)
        if chars.count >= 3, chars[0].isLetter, chars[1] == ":", chars[2] == "/" || chars[2] == "\\" {
            return false  // Windows root A:\ / A:/
        }
        for segment in key.split(separator: "/", omittingEmptySubsequences: false) {
            if segment.isEmpty || segment == "." || segment == ".." { return false }
            if segment.contains("\\") || segment.contains("\0") { return false }
        }
        return true
    }

    /// `safeFilename(basename, ext)`: names that fit (incl. the 32-byte atomic-write
    /// temp budget) pass through; longer ones are truncated on a UTF-8 scalar
    /// boundary and tagged with a 12-hex SHA-1 prefix of the full basename, so two
    /// distinct long identifiers never collide on disk.
    static func safeFilename(basename: String, ext: String) -> String {
        let maxComponentBytes = 255
        let tmpSuffixBudget = 32
        let hashPrefixLen = 12
        let fullName = basename + ext
        if fullName.utf8.count + tmpSuffixBudget <= maxComponentBytes { return fullName }
        let digest = Insecure.SHA1.hash(data: Data(basename.utf8))
        let hashPrefix = String(digest.map { String(format: "%02x", $0) }.joined().prefix(hashPrefixLen))
        let budget = Swift.max(0, maxComponentBytes - tmpSuffixBudget - ext.utf8.count - 1 - hashPrefixLen)
        return "\(truncateUTF8(basename, maxBytes: budget))~\(hashPrefix)\(ext)"
    }

    /// Truncate to at most `maxBytes` UTF-8 bytes without splitting a scalar
    /// (JS `truncateToBytes`: iterate code points, stop before the next overflows).
    static func truncateUTF8(_ text: String, maxBytes: Int) -> String {
        if text.utf8.count <= maxBytes { return text }
        var used = 0
        var out = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            let width = String(scalar).utf8.count
            if used + width > maxBytes { break }
            out.append(scalar)
            used += width
        }
        return String(out)
    }

    // MARK: - tag-derived determinism (mirrors snapshot.js)

    /// `^[a-z0-9._-]{1,64}$` (case-insensitive) — rejects path-escape / shell-meta
    /// tags before they reach archive/checksum/manifest filenames.
    static func isValidTag(_ tag: String) -> Bool {
        guard (1...64).contains(tag.count) else { return false }
        return tag.utf8.allSatisfy { byte in
            (byte >= 0x61 && byte <= 0x7A)  // a-z
                || (byte >= 0x41 && byte <= 0x5A)  // A-Z
                || (byte >= 0x30 && byte <= 0x39)  // 0-9
                || byte == 0x2E || byte == 0x5F || byte == 0x2D  // . _ -
        }
    }

    /// A `snapshot-YYYYMMDD` tag → midnight-UTC ISO of that day; else the Unix epoch
    /// (both stable across reruns of the same tag).
    static func deterministicCreatedAt(_ tag: String) -> String {
        guard let date = snapshotDate(tag) else { return "1970-01-01T00:00:00.000Z" }
        return String(
            format: "%04d-%02d-%02dT00:00:00.000Z", date.year, date.month, date.day)
    }

    /// Seconds-since-epoch counterpart of ``deterministicCreatedAt`` (the value the
    /// staged-file mtimes are clamped to).
    static func deterministicMtimeSeconds(_ tag: String) -> Int64 {
        guard let date = snapshotDate(tag) else { return 0 }
        var components = DateComponents()
        components.year = date.year
        components.month = date.month
        components.day = date.day
        var calendar = Calendar(identifier: .gregorian)
        guard let utc = TimeZone(identifier: "UTC") else { return 0 }
        calendar.timeZone = utc
        guard let resolved = calendar.date(from: components) else { return 0 }
        return Int64(resolved.timeIntervalSince1970)
    }

    /// Parse `snapshot-YYYYMMDD` → (year, month, day), or nil.
    private static func snapshotDate(_ tag: String) -> (year: Int, month: Int, day: Int)? {
        let prefix = "snapshot-"
        guard tag.hasPrefix(prefix) else { return nil }
        let digits = tag.dropFirst(prefix.count)
        guard digits.count == 8, digits.allSatisfy(\.isNumber) else { return nil }
        let chars = Array(digits)
        guard let year = Int(String(chars[0..<4])),
            let month = Int(String(chars[4..<6])),
            let day = Int(String(chars[6..<8])),
            (1...12).contains(month), (1...31).contains(day)
        else { return nil }
        return (year, month, day)
    }
}
