import Foundation

/// Pre-extraction archive member and path-containment validator (Threat Model T-01).
///
/// Rejects absolute paths, `..` traversal, backslashes, NUL/control bytes, symlinks/hardlinks,
/// and any member outside the optional allowlist before `tar`/`zstd` touches the filesystem.
public enum ArchiveSafetyValidator: Sendable {
    /// Tar/archive member entry type classified prior to extraction.
    public enum MemberKind: Hashable, Sendable {
        case regularFile
        case directory
        case symlink
        case hardlink
        case special
    }

    /// Single archive member descriptor inspected before extraction.
    public struct Member: Hashable, Sendable {
        public let path: String
        public let kind: MemberKind
        public let uncompressedBytes: Int64

        public init(path: String, kind: MemberKind = .regularFile, uncompressedBytes: Int64 = 0) {
            self.path = path
            self.kind = kind
            self.uncompressedBytes = uncompressedBytes
        }
    }

    /// Validates every member in `members` against traversal, link, size, and allowlist rules.
    public static func validate(
        members: [Member],
        allowedTopLevelPrefixes: Set<String>? = nil,
        maxTotalBytes: Int64 = 12_884_901_888
    ) throws(SetupError) {
        var runningTotal: Int64 = 0
        for member in members {
            let normalized = try normalizeMemberPath(member.path)
            switch member.kind {
                case .regularFile, .directory:
                    break
                case .symlink:
                    throw .unsafeArchiveMember(path: member.path, reason: "symbolic links are forbidden")
                case .hardlink:
                    throw .unsafeArchiveMember(path: member.path, reason: "hard links are forbidden")
                case .special:
                    throw .unsafeArchiveMember(path: member.path, reason: "special device/FIFO entries are forbidden")
            }
            if let prefixes = allowedTopLevelPrefixes {
                let top = String(normalized.split(separator: "/").first ?? "")
                guard prefixes.contains(top) else {
                    throw .unsafeArchiveMember(path: member.path, reason: "outside allowlist (\(top))")
                }
            }
            guard member.uncompressedBytes >= 0 else {
                throw .unsafeArchiveMember(path: member.path, reason: "negative size")
            }
            let (nextTotal, overflow) = runningTotal.addingReportingOverflow(member.uncompressedBytes)
            guard !overflow, nextTotal <= maxTotalBytes else {
                throw .unsafeArchiveMember(path: member.path, reason: "archive exceeds max size budget")
            }
            runningTotal = nextTotal
        }
    }

    /// Verifies that `candidatePath` resolves lexically inside `rootPath` with no escape.
    public static func resolveContainedPath(relative: String, insideRoot rootPath: String) throws(SetupError) -> String
    {
        let safeRelative = try normalizeMemberPath(relative)
        let rootURL = URL(fileURLWithPath: rootPath, isDirectory: true).standardizedFileURL
        let joined = rootURL.appendingPathComponent(safeRelative).standardizedFileURL
        let rootPrefix = rootURL.path.hasSuffix("/") ? rootURL.path : rootURL.path + "/"
        guard joined.path == rootURL.path || joined.path.hasPrefix(rootPrefix) else {
            throw .pathEscapesRoot(path: relative)
        }
        return joined.path
    }

    private static func normalizeMemberPath(_ raw: String) throws(SetupError) -> String {
        guard !raw.isEmpty else {
            throw .unsafeArchiveMember(path: raw, reason: "empty path")
        }
        for byte in raw.utf8 {
            if byte == 0x00 || byte < 0x20 || byte == 0x7F {
                throw .unsafeArchiveMember(path: raw, reason: "control or NUL byte")
            }
            if byte == 0x5C {
                throw .unsafeArchiveMember(path: raw, reason: "backslash separator")
            }
        }
        var stripped = raw
        while stripped.hasPrefix("./") {
            stripped.removeFirst(2)
        }
        guard !stripped.hasPrefix("/"), !stripped.hasPrefix("~") else {
            throw .unsafeArchiveMember(path: raw, reason: "absolute or home-relative path")
        }
        let segments = stripped.split(separator: "/", omittingEmptySubsequences: false)
        var cleaned: [Substring] = []
        for segment in segments {
            if segment.isEmpty { continue }
            if segment == "." || segment == ".." {
                throw .unsafeArchiveMember(path: raw, reason: "traversal segment '\(segment)'")
            }
            cleaned.append(segment)
        }
        guard !cleaned.isEmpty else {
            throw .unsafeArchiveMember(path: raw, reason: "empty normalized path")
        }
        return cleaned.joined(separator: "/")
    }
}
