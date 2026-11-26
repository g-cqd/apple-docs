/// Validated, canonical corpus document key (e.g. `swiftui/view`, `app-store-review/3.1`).
///
/// Rejects empty keys, leading/trailing slashes, path traversal segments (`..`, `.`),
/// backslashes, control characters, and embedded NUL bytes at construction time so
/// downstream storage, search, and web routing never receive unvalidated keys.
public struct DocumentKey: Hashable, Sendable, Codable, CustomStringConvertible {
    /// Maximum UTF-8 byte length permitted for a single document key.
    public static let maximumByteCount = 512

    /// Canonical slash-separated lowercase key string.
    public let rawValue: String

    /// The first path segment (typically the framework or collection root slug).
    public var rootSlug: String {
        if let slash = rawValue.firstIndex(of: "/") {
            return String(rawValue[..<slash])
        }
        return rawValue
    }

    public var description: String { rawValue }

    /// Creates a validated canonical `DocumentKey`.
    /// - Parameter raw: Untrusted document key string.
    /// - Throws: ``DocumentKeyError`` when the input violates structural or security invariants.
    public init(_ raw: String) throws(DocumentKeyError) {
        let trimmed = Self.trimWhitespaceASCII(raw)
        guard !trimmed.isEmpty else {
            throw .empty
        }
        guard trimmed.utf8.count <= Self.maximumByteCount else {
            throw .exceedsMaxLength(limit: Self.maximumByteCount)
        }
        guard !trimmed.hasPrefix("/"), !trimmed.hasPrefix("~") else {
            throw .absolutePath
        }
        for byte in trimmed.utf8 {
            if byte == 0x00 || byte < 0x20 || byte == 0x7F {
                throw .controlCharacter
            }
            if byte == 0x5C {
                throw .backslash
            }
        }
        let segments = trimmed.split(separator: "/", omittingEmptySubsequences: false)
        for segment in segments {
            guard !segment.isEmpty else {
                throw .emptySegment
            }
            guard segment != ".", segment != ".." else {
                throw .pathTraversal
            }
        }
        self.rawValue = trimmed.lowercased()
    }

    private static func trimWhitespaceASCII(_ value: String) -> String {
        var bytes = Array(value.utf8)
        while let first = bytes.first, first == 0x20 || first == 0x09 {
            bytes.removeFirst()
        }
        while let last = bytes.last, last == 0x20 || last == 0x09 {
            bytes.removeLast()
        }
        return String(decoding: bytes, as: UTF8.self)
    }
}
