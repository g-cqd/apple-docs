/// Public projection chokepoint utilities: deterministic JSON encoding and Markdown slicing.
import Foundation

public enum PublicProjection: Sendable {
    /// Encodes any `Encodable` public DTO into deterministic UTF-8 JSON (sorted keys).
    public static func encodeJSON<T: Encodable>(_ value: T, pretty: Bool = false) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
        let data = try encoder.encode(value)
        return String(decoding: data, as: UTF8.self)
    }

    /// Returns a bounded slice of `markdown` with pagination metadata.
    public static func paginate(_ markdown: String, maxChars: Int, page: Int = 1) -> PageSlice {
        let clampedLimit = max(512, min(maxChars, 100_000))
        let clampedPage = max(1, page)
        let scalars = Array(markdown)
        let totalPages = max(1, (scalars.count + clampedLimit - 1) / clampedLimit)
        let start = (clampedPage - 1) * clampedLimit
        guard start < scalars.count else {
            return PageSlice(text: "", page: clampedPage, totalPages: totalPages, totalChars: scalars.count)
        }
        let end = min(scalars.count, start + clampedLimit)
        return PageSlice(
            text: String(scalars[start ..< end]),
            page: clampedPage,
            totalPages: totalPages,
            totalChars: scalars.count
        )
    }

    /// Paginated text slice returned by ``paginate(_:maxChars:page:)``.
    public struct PageSlice: Hashable, Sendable, Codable {
        public let text: String
        public let page: Int
        public let totalPages: Int
        public let totalChars: Int
    }
}
