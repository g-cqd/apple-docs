import AemiHTML
import AppleDocsContent
import AppleDocsCore

/// Shared path-prefix, conditional-GET, DocC conversion, and HTML helpers across source adapters.
enum AdapterHelpers {
    static func collectionRoot(
        slug: String,
        displayName: String,
        kind: String = "collection",
        sourceType: SourceKind,
        seedPath: String
    ) -> CorpusRootRecord {
        CorpusRootRecord(slug: slug, displayName: displayName, kind: kind, sourceType: sourceType, seedPath: seedPath)
    }

    static func singleSeed(_ path: String) -> [DocumentKey] {
        (try? DocumentKey(path)).map { [$0] } ?? []
    }

    static func stripRootPrefix(_ rootSlug: String, from key: DocumentKey) throws(SourceError) -> String {
        let prefix = "\(rootSlug)/"
        guard key.rawValue.hasPrefix(prefix) else {
            throw .unsafeURL(key.rawValue, reason: "Key '\(key.rawValue)' does not belong to '\(rootSlug)'")
        }
        return String(key.rawValue.dropFirst(prefix.count))
    }

    static func fetchTransformed(
        url: String,
        previousETag: String?,
        headers: [String: String] = [:],
        client: UpstreamHTTPClient,
        transform: (UpstreamFetchResponse) async throws(SourceError) -> (ConvertedDocument, [DocumentKey])
    ) async throws(SourceError) -> SourceFetchOutcome {
        let response: UpstreamFetchResponse
        switch try await client.conditionalGet(url: url, etag: previousETag, headers: headers) {
            case .notModified: return .notModified
            case .gone: return .notFound
            case .ok(let ok): response = ok
        }
        let (converted, discovered) = try await transform(response)
        return .modified(
            payload: SourcePayload(converted: converted),
            etag: response.etag,
            discoveredKeys: discovered
        )
    }

    static func fetchDocCArchivePage(
        url: String,
        pageURL: String,
        key: DocumentKey,
        sourceType: SourceKind,
        previousETag: String?,
        client: UpstreamHTTPClient,
        keyMapper: (@Sendable (String) -> String)? = nil,
        filterDiscovered: (@Sendable (DocumentKey) -> Bool)? = nil
    ) async throws(SourceError) -> SourceFetchOutcome {
        try await fetchTransformed(url: url, previousETag: previousETag, client: client) {
            response throws(SourceError) in
            let converted: ConvertedDocument
            do {
                converted = try DocCJSONConverter.convert(
                    json: response.body,
                    key: key,
                    sourceType: sourceType,
                    url: pageURL,
                    keyMapper: keyMapper
                )
            } catch {
                throw .malformedPayload(url: url, reason: "DocC JSON parse error: \(error)")
            }
            let discovered = filterDiscovered.map { converted.discoveredKeys.filter($0) } ?? []
            return (converted, discovered)
        }
    }

    static func isAnyElement(_ doc: HTMLDocument, _ node: HTMLDocument.Node, _ tags: [String]) -> Bool {
        tags.contains { doc.isElement(node, $0) }
    }

    static func decodeBasicHTMLEntities(_ text: String) -> String {
        text.replacing("&quot;", with: "\"")
            .replacing("&#39;", with: "'")
            .replacing("&lt;", with: "<")
            .replacing("&gt;", with: ">")
            .replacing("&amp;", with: "&")
    }

    static func collapseWhitespace(_ raw: String) -> String {
        raw.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
