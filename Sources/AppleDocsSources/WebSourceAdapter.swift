import AemiRegex
public import AppleDocsCore

/// Unified, data-driven upstream source adapter powering all 11 Apple & Swift documentation sources
/// (`apple-docc`, `hig`, `guidelines`, `wwdc`, `sample-code`, `swift-evolution`, `swift-book`,
/// `swift-docc`, `swift-org`, `apple-archive`, `packages`).
public struct WebSourceAdapter: SourceAdapter, Sendable {
    /// Declarative endpoint configuration describing how a source maps ``DocumentKey`` to HTTPS URLs.
    public struct Spec: Hashable, Sendable, Codable {
        public let kind: SourceKind
        public let displayName: String
        public let rootSlug: String
        public let rootKind: String
        public let seedPath: String
        public let host: String
        public let basePathSegments: [String]
        public let dropsRootSegment: Bool
        public let fileExtension: String?
        public let encoding: SourcePayload.Encoding
    }

    public let spec: Spec

    public init(spec: Spec) {
        self.spec = spec
    }

    public var kind: SourceKind { spec.kind }
    public var displayName: String { spec.displayName }

    public var defaultRoot: CorpusRootRecord {
        CorpusRootRecord(
            slug: spec.rootSlug,
            displayName: spec.displayName,
            kind: spec.rootKind,
            sourceType: spec.kind,
            seedPath: spec.seedPath
        )
    }

    public var seedKeys: [DocumentKey] {
        guard let key = (try? DocumentKey(spec.seedPath)) ?? (try? DocumentKey(spec.rootSlug)) else { return [] }
        return [key]
    }

    public func dataURL(for key: DocumentKey) throws(SourceError) -> String {
        let rawSegments = key.rawValue.split(separator: "/").map(String.init)
        var tail = spec.dropsRootSegment ? Array(rawSegments.dropFirst()) : rawSegments
        if tail.isEmpty, let first = rawSegments.first { tail = [first] }
        if let ext = spec.fileExtension, let last = tail.last, !last.hasSuffix(".\(ext)") {
            tail[tail.count - 1] = "\(last).\(ext)"
        }
        return try UpstreamHTTPClient.buildHTTPSURL(host: spec.host, pathSegments: spec.basePathSegments + tail)
    }

    public func fetch(
        key: DocumentKey,
        previousETag: String?,
        client: UpstreamHTTPClient
    ) async throws(SourceError) -> SourceFetchOutcome {
        let url = try dataURL(for: key)
        let response: UpstreamFetchResponse
        switch try await client.conditionalGet(url: url, etag: previousETag) {
            case .notModified: return .notModified
            case .gone: return .notFound
            case .ok(let ok): response = ok
        }
        let payload = SourcePayload(
            key: key,
            sourceType: spec.kind,
            fallbackTitle: key.rawValue,
            url: url,
            encoding: spec.encoding,
            body: response.body
        )
        return .modified(payload: payload, etag: response.etag, discoveredKeys: [])
    }

    /// Detects whether a DocC path segment looks like a Swift operator slug (e.g. `._(_:_:)`)
    /// using linear-time `g-cqd/AemiRegex` (zero ReDoS risk).
    public static func isOperatorSegment(_ segment: String) -> Bool {
        guard let pattern = try? Pattern("^\\.[.+*/<>=!&|^~%_\\-]") else { return false }
        return pattern.firstMatch(in: segment) != nil
    }
}
