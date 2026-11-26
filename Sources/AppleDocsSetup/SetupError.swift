/// Typed errors thrown by cross-platform and Darwin-gated setup operations.
public enum SetupError: Error, Hashable, Sendable, CustomStringConvertible {
    case checksumMismatch(expected: String, actual: String)
    case invalidChecksumFormat(String)
    case unsafeArchiveMember(path: String, reason: String)
    case pathEscapesRoot(path: String)
    case missingHostTool(String)
    case unsupportedOnPlatform(feature: String)
    case commandFailed(tool: String, exitCode: Int32, stderr: String)
    case ioFailure(String)

    public var description: String {
        switch self {
            case .checksumMismatch(let expected, let actual):
                "SHA-256 mismatch: expected \(expected), got \(actual)."
            case .invalidChecksumFormat(let raw):
                "Invalid SHA-256 hex digest: \(raw)."
            case .unsafeArchiveMember(let path, let reason):
                "Rejected archive member '\(path)': \(reason)."
            case .pathEscapesRoot(let path):
                "Path escapes destination root: \(path)."
            case .missingHostTool(let tool):
                "Required host tool not found: \(tool)."
            case .unsupportedOnPlatform(let feature):
                "\(feature) is only supported on macOS."
            case .commandFailed(let tool, let code, let stderr):
                "\(tool) failed with exit code \(code): \(stderr)"
            case .ioFailure(let message):
                "Setup I/O failure: \(message)"
        }
    }
}
