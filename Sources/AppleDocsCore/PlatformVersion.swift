/// Encodes an Apple platform version string (e.g. `"17.4"`, `"10.15.1"`, `"26.0 beta"`)
/// into a sortable integer (`MAJOR * 1_000_000 + MINOR * 1_000 + PATCH`).
///
/// Matches the `encodeVersion` contract so numeric platform predicates never suffer
/// lexicographic regressions like `"10.0" < "9.0"`.
public struct PlatformVersion: Hashable, Sendable, Comparable, Codable, CustomStringConvertible {
    private static let componentBase = 1_000

    public let major: Int
    public let minor: Int
    public let patch: Int

    /// Packed sortable integer representation (`MAJOR * 1_000_000 + MINOR * 1_000 + PATCH`).
    public var encoded: Int64 {
        Int64(major) * 1_000_000 + Int64(minor) * 1_000 + Int64(patch)
    }

    public var description: String {
        patch == 0 ? "\(major).\(minor)" : "\(major).\(minor).\(patch)"
    }

    /// Creates a validated `PlatformVersion` from numeric components.
    public init?(major: Int, minor: Int = 0, patch: Int = 0) {
        guard major >= 0, major < Self.componentBase,
            minor >= 0, minor < Self.componentBase,
            patch >= 0, patch < Self.componentBase
        else {
            return nil
        }
        self.major = major
        self.minor = minor
        self.patch = patch
    }

    /// Parses a leading `MAJOR[.MINOR[.PATCH]]` prefix, ignoring trailing markers like `" beta"` or `"+"`.
    public init?(parsing raw: String) {
        let trimmed = raw.drop(while: { $0 == " " || $0 == "\t" })
        guard !trimmed.isEmpty else { return nil }

        var prefix = ""
        for character in trimmed {
            guard character.isASCII, character.isNumber || character == "." else {
                break
            }
            prefix.append(character)
        }
        guard !prefix.isEmpty, !prefix.hasPrefix("."), !prefix.hasSuffix(".") else {
            return nil
        }

        let parts = prefix.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 4 else { return nil }

        var numbers: [Int] = []
        numbers.reserveCapacity(parts.count)
        for part in parts {
            guard let value = Int(part), value >= 0, value < Self.componentBase else {
                return nil
            }
            numbers.append(value)
        }
        self.major = numbers[0]
        self.minor = numbers.count > 1 ? numbers[1] : 0
        self.patch = numbers.count > 2 ? numbers[2] : 0
    }

    /// Decodes a packed `encoded` integer back into components.
    public init?(encoded: Int64) {
        guard encoded >= 0, encoded < 1_000_000_000 else { return nil }
        let major = Int(encoded / 1_000_000)
        let minor = Int((encoded / 1_000) % 1_000)
        let patch = Int(encoded % 1_000)
        self.init(major: major, minor: minor, patch: patch)
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.encoded < rhs.encoded
    }
}
