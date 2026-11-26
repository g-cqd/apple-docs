import Foundation
import URLBuilder

/// Hardened upstream HTTP client with SSRF/scheme validation, conditional GET (`ETag` / `If-None-Match`),
/// bounded response sizes, and deterministic injectable backoff on `429`/`5xx` (Threat Model T-04).
public final class UpstreamHTTPClient: Sendable {
    /// Policy governing scheme, host, retry budget, and optional sleep hook for deterministic tests.
    public struct Policy: Sendable {
        public let maxAttempts: Int
        public let maxBodyBytes: Int
        public let allowedHosts: Set<String>?
        public let sleepBeforeRetry: @Sendable (Int) async -> Void

        public init(
            maxAttempts: Int = 3,
            maxBodyBytes: Int = 16_777_216,
            allowedHosts: Set<String>? = nil,
            sleepBeforeRetry: @escaping @Sendable (Int) async -> Void = { _ in }
        ) {
            self.maxAttempts = max(1, min(maxAttempts, 8))
            self.maxBodyBytes = max(1_024, maxBodyBytes)
            self.allowedHosts = allowedHosts
            self.sleepBeforeRetry = sleepBeforeRetry
        }
    }

    private let transport: any UpstreamHTTPTransport
    private let policy: Policy

    public init(
        transport: any UpstreamHTTPTransport = URLSessionUpstreamTransport(),
        policy: Policy = Policy()
    ) {
        self.transport = transport
        self.policy = policy
    }

    /// Validates `url` against HTTPS-only & SSRF rules (rejecting loopback, link-local, private RFC1918,
    /// metadata IPs, and embedded credentials) before issuing a conditional GET with retries.
    public func get(
        url: String,
        ifNoneMatch: String? = nil,
        ifModifiedSince: String? = nil
    ) async throws(SourceError) -> UpstreamFetchResponse {
        try Self.validatePublicHTTPSURL(url, allowedHosts: policy.allowedHosts)
        let request = UpstreamFetchRequest(
            url: url,
            ifNoneMatch: ifNoneMatch,
            ifModifiedSince: ifModifiedSince,
            maxBodyBytes: policy.maxBodyBytes
        )

        var lastStatus: Int?
        for attempt in 1 ... policy.maxAttempts {
            let response: UpstreamFetchResponse
            do {
                response = try await transport.fetch(request)
            } catch .networkFailure {
                if attempt == policy.maxAttempts {
                    throw .retryExhausted(url: url, lastStatus: lastStatus)
                }
                await policy.sleepBeforeRetry(attempt)
                continue
            } catch let other {
                throw other
            }

            lastStatus = response.statusCode
            if response.statusCode == 429 || (response.statusCode >= 500 && response.statusCode <= 599) {
                if attempt == policy.maxAttempts {
                    throw .retryExhausted(url: url, lastStatus: lastStatus)
                }
                await policy.sleepBeforeRetry(response.retryAfterSeconds ?? attempt)
                continue
            }
            return response
        }
        throw .retryExhausted(url: url, lastStatus: lastStatus)
    }

    /// Builds a validated HTTPS URL from `host` and `pathSegments` via `g-cqd/URLBuilder`.
    public static func buildHTTPSURL(host: String, pathSegments: [String]) throws(SourceError) -> String {
        do {
            let url = try withThrowingURL {
                HTTPS(host) {
                    for segment in pathSegments where !segment.isEmpty {
                        Path(segment)
                    }
                }
            }
            return url.absoluteString
        } catch {
            throw .unsafeURL(host, reason: "URLBuilder validation failed: \(error)")
        }
    }

    /// Rejects non-HTTPS URLs, embedded credentials, loopback/private/link-local hosts, and hosts outside `allowedHosts`.
    public static func validatePublicHTTPSURL(
        _ rawURL: String,
        allowedHosts: Set<String>? = nil
    ) throws(SourceError) {
        guard let components = URLComponents(string: rawURL),
            let scheme = components.scheme?.lowercased(),
            scheme == "https"
        else {
            throw .unsafeURL(rawURL, reason: "only https:// URLs are permitted")
        }
        guard components.user == nil, components.password == nil else {
            throw .unsafeURL(rawURL, reason: "embedded URL credentials are forbidden")
        }
        guard let host = components.host?.lowercased(), !host.isEmpty else {
            throw .unsafeURL(rawURL, reason: "missing host")
        }
        if isPrivateOrLoopbackHost(host) {
            throw .unsafeURL(rawURL, reason: "loopback, link-local, or private host '\(host)' is forbidden")
        }
        if let allowedHosts, !allowedHosts.contains(host) {
            throw .unsafeURL(rawURL, reason: "host '\(host)' is not in the allowlist")
        }
    }

    private static func isPrivateOrLoopbackHost(_ host: String) -> Bool {
        let bare = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if bare == "localhost" || bare.hasSuffix(".localhost") || bare.hasSuffix(".local") || bare == "::1" {
            return true
        }
        let octets = bare.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4, octets.allSatisfy({ $0 >= 0 && $0 <= 255 }) else {
            return bare.hasPrefix("fc") || bare.hasPrefix("fd") || bare.hasPrefix("fe80")
        }
        let (a, b) = (octets[0], octets[1])
        return a == 0 || a == 10 || a == 127
            || (a == 169 && b == 254)
            || (a == 172 && b >= 16 && b <= 31)
            || (a == 192 && b == 168)
            || (a == 100 && b >= 64 && b <= 127)
    }
}
