/// Typed validation failures emitted when parsing an untrusted ``DocumentKey``.
public enum DocumentKeyError: Error, Hashable, Sendable, CustomStringConvertible {
    case empty
    case exceedsMaxLength(limit: Int)
    case absolutePath
    case backslash
    case controlCharacter
    case emptySegment
    case pathTraversal

    public var description: String {
        switch self {
            case .empty:
                "Document key must not be empty."
            case .exceedsMaxLength(let limit):
                "Document key exceeds maximum length of \(limit) bytes."
            case .absolutePath:
                "Document key must be a relative path."
            case .backslash:
                "Document key must not contain backslashes."
            case .controlCharacter:
                "Document key must not contain control or NUL bytes."
            case .emptySegment:
                "Document key must not contain empty path segments."
            case .pathTraversal:
                "Document key must not contain traversal segments ('.' or '..')."
        }
    }
}
