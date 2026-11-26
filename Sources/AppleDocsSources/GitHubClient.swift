import AemiJSONCore
import Foundation

/// GitHub REST / raw content helpers shared by `swift-evolution`, `swift-book`, `wwdc`, and `packages`.
/// Respects `GITHUB_TOKEN` / `GH_TOKEN` when present in the process environment.
public enum GitHubClient: Sendable {
    public struct TreeEntry: Hashable, Sendable {
        public let path: String
        public let type: String

        public init(path: String, type: String) {
            self.path = path
            self.type = type
        }
    }

    public static func resolvedToken(environment: [String: String]? = nil) -> String? {
        let env = environment ?? ProcessInfo.processInfo.environment
        for key in ["GITHUB_TOKEN", "GH_TOKEN"] {
            if let value = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty {
                return value
            }
        }
        return nil
    }

    public static func apiHeaders(token: String? = resolvedToken()) -> [String: String] {
        var headers = [
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"
        ]
        if let token, !token.isEmpty {
            headers["Authorization"] = "Bearer \(token)"
        }
        return headers
    }

    public static func rawHeaders(token: String? = resolvedToken()) -> [String: String] {
        guard let token, !token.isEmpty else { return [:] }
        return ["Authorization": "Bearer \(token)"]
    }

    /// Fetches the recursive git tree for `owner/repo@branch` (`api.github.com/repos/.../git/trees/...?recursive=1`).
    /// Fails closed if GitHub marks the tree listing `truncated: true`.
    public static func fetchTree(
        owner: String,
        repo: String,
        branch: String,
        client: UpstreamHTTPClient,
        token: String? = resolvedToken()
    ) async throws(SourceError) -> [TreeEntry] {
        let url = "https://api.github.com/repos/\(owner)/\(repo)/git/trees/\(branch)?recursive=1"
        let response = try await client.get(url: url, headers: apiHeaders(token: token))
        guard (200 ... 299).contains(response.statusCode) else {
            throw .httpStatus(response.statusCode, url: url)
        }
        let doc: JSONDocument
        do {
            doc = try AemiJSON.parse(response.body)
        } catch {
            throw .malformedPayload(url: url, reason: "GitHub tree JSON parse error: \(error)")
        }
        let root = doc.root
        if root["truncated"].bool == true {
            throw .malformedPayload(url: url, reason: "GitHub tree listing truncated for \(owner)/\(repo)@\(branch)")
        }
        var entries: [TreeEntry] = []
        for item in root["tree"].array ?? [] {
            guard let path = item["path"].string, let type = item["type"].string else { continue }
            entries.append(TreeEntry(path: path, type: type))
        }
        return entries
    }

    public static func rawURL(owner: String, repo: String, branch: String, filePath: String) -> String {
        let clean = filePath.hasPrefix("/") ? String(filePath.dropFirst()) : filePath
        return "https://raw.githubusercontent.com/\(owner)/\(repo)/\(branch)/\(clean)"
    }
}
