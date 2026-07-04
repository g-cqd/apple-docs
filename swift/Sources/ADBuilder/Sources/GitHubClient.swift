// GitHubClient — the GitHub access layer the GitHub-backed adapters (swift-evolution,
// packages, sample-code, swift-book, swift-docc) share (port of src/lib/github.js).
// POLICY over the `HTTPClient` transport: recursive git-tree discovery, raw-file
// fetch, and a conditional-GET change check, all through the `RateLimiter` +
// `RetryPolicy`. HTTP status is interpreted here (404 → notFound / http-error, !2xx →
// httpStatus), since the transport returns it verbatim.
import Foundation
import HTTPTypes
import HTTPTypesFoundation

public struct GitHubClient: Sendable {
    private let client: any HTTPClient
    private let rateLimiter: RateLimiter
    private let token: String?
    private let timeout: Duration

    static let userAgent = "apple-docs/2.0"
    static let apiVersionName = HTTPField.Name("x-github-api-version")!

    public init(
        client: any HTTPClient, rateLimiter: RateLimiter,
        token: String? = GitHubClient.tokenFromEnvironment(), timeout: Duration = .seconds(45)
    ) {
        self.client = client
        self.rateLimiter = rateLimiter
        self.token = token
        self.timeout = timeout
    }

    public enum GitHubError: Error, Sendable, Equatable {
        case malformedURL(String)
        case notFound(String)
        case httpStatus(Int, String)
        case decode(String)
        case transport(FetchError)
    }

    /// A recursive git-tree entry (`fetchGitHubTree` result element).
    public struct TreeEntry: Sendable, Equatable {
        public var path: String
        public var type: String
        public var sha: String
        public var size: Int?
    }

    /// A raw file plus its HTTP validators (`fetchRawGitHub` result).
    public struct RawFile: Sendable, Equatable {
        public var text: String
        public var etag: String?
        public var lastModified: String?
    }

    // MARK: - tree / raw / check

    /// The full recursive git tree for a branch.
    public func fetchTree(owner: String, repo: String, branch: String) async throws -> [TreeEntry] {
        let url = "https://api.github.com/repos/\(owner)/\(repo)/git/trees/\(branch)?recursive=1"
        let response = try await get(url, headers: apiHeaders(), method: .get, notFoundIsError: true)
        let bytes = try await collect(response, limit: 64 << 20, url: url)
        guard let object = try? JSONSerialization.jsonObject(with: Data(bytes)) as? [String: Any],
            let tree = object["tree"] as? [[String: Any]]
        else { throw GitHubError.decode(url) }
        return tree.compactMap { entry in
            guard let path = entry["path"] as? String, let type = entry["type"] as? String,
                let sha = entry["sha"] as? String
            else { return nil }
            return TreeEntry(path: path, type: type, sha: sha, size: entry["size"] as? Int)
        }
    }

    /// A raw file from `raw.githubusercontent.com`.
    public func fetchRaw(
        owner: String, repo: String, branch: String, filePath: String
    ) async throws -> RawFile {
        let url = "https://raw.githubusercontent.com/\(owner)/\(repo)/\(branch)/\(filePath)"
        let response = try await get(url, headers: rawHeaders(), method: .get, notFoundIsError: false)
        let bytes = try await collect(response, limit: 16 << 20, url: url)
        return RawFile(
            text: String(decoding: bytes, as: UTF8.self), etag: response.etag,
            lastModified: response.lastModified)
    }

    /// Conditional-GET change check on a raw file (a single HEAD, no retry — the JS
    /// `checkResourceEtag`): 304 → unchanged, 404 → deleted, 2xx → modified, else error.
    public func checkRaw(
        owner: String, repo: String, branch: String, filePath: String, previousEtag: String?
    ) async throws -> CheckResult {
        let url = "https://raw.githubusercontent.com/\(owner)/\(repo)/\(branch)/\(filePath)"
        try await rateLimiter.acquire()
        guard let parsed = URL(string: url) else { return CheckResult(status: .error, changed: false) }
        var head = HTTPRequest(url: parsed)
        head.method = .head
        head.headerFields = rawHeaders()
        if let previousEtag { head.headerFields[.ifNoneMatch] = previousEtag }
        do {
            let response = try await client.send(HTTPClientRequest(head, deadline: timeout))
            switch response.status.code {
                case 304: return CheckResult(status: .unchanged, changed: false, newState: previousEtag)
                case 404: return CheckResult(status: .deleted, changed: false, deleted: true)
                case 200 ..< 300: return CheckResult(status: .modified, changed: true, newState: response.etag)
                default: return CheckResult(status: .error, changed: false)
            }
        } catch {
            return CheckResult(status: .error, changed: false)
        }
    }

    // MARK: - request plumbing

    /// Rate-limited + retried GET/HEAD; interprets the status (404 → notFound or
    /// http-error per `notFoundIsError`, !2xx → httpStatus). Returns a 2xx response.
    private func get(
        _ url: String, headers: HTTPFields, method: HTTPRequest.Method, notFoundIsError: Bool
    ) async throws -> HTTPClientResponse {
        guard let parsed = URL(string: url) else { throw GitHubError.malformedURL(url) }
        var head = HTTPRequest(url: parsed)
        head.method = method
        head.headerFields = headers
        let response: HTTPClientResponse
        do {
            response = try await RetryPolicy.fetchWithRetry(
                HTTPClientRequest(head, deadline: timeout), using: client, rateLimiter: rateLimiter)
        } catch let error as FetchError {
            throw GitHubError.transport(error)
        }
        let status = response.status.code
        if status == 404 {
            throw notFoundIsError ? GitHubError.httpStatus(404, url) : GitHubError.notFound(url)
        }
        guard (200 ..< 300).contains(status) else { throw GitHubError.httpStatus(status, url) }
        return response
    }

    private func collect(_ response: HTTPClientResponse, limit: Int, url: String) async throws -> [UInt8] {
        do {
            return try await response.body.collect(upTo: limit)
        } catch {
            throw GitHubError.decode(url)
        }
    }

    private func apiHeaders() -> HTTPFields {
        var fields = HTTPFields()
        fields[.userAgent] = Self.userAgent
        fields[.accept] = "application/vnd.github+json"
        fields[Self.apiVersionName] = "2022-11-28"
        if let token { fields[.authorization] = "Bearer \(token)" }
        return fields
    }

    private func rawHeaders() -> HTTPFields {
        var fields = HTTPFields()
        fields[.userAgent] = Self.userAgent
        if let token { fields[.authorization] = "Bearer \(token)" }
        return fields
    }

    /// The GitHub token from the environment (env vars only; JS also has a
    /// runtime-resolved fallback, not modeled here).
    public static func tokenFromEnvironment() -> String? {
        let environment = ProcessInfo.processInfo.environment
        if let token = environment["GITHUB_TOKEN"], !token.isEmpty { return token }
        if let token = environment["GH_TOKEN"], !token.isEmpty { return token }
        return nil
    }
}
