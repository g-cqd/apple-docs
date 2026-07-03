// GitHub Releases helper for the ops pipeline — the native port of
// ops/lib/gh-release.js. Fetches /releases/latest, picks the snapshot tarball +
// its sha256 sidecar, downloads + verifies the checksum. The HTTP transport is a
// single injectable seam (`GhFetcher`) so the suite never hits api.github.com.

private import Foundation

private let userAgent = "apple-docs-ops/2.0"

/// A GitHub release asset.
public struct ReleaseAsset: Sendable, Equatable {
    public let name: String
    public let size: Int
    public let url: String
}

/// A normalized release payload (mirrors the JS `fetchLatest` shape).
public struct Release: Sendable, Equatable {
    public let tagName: String
    public let publishedAt: String
    public let assets: [ReleaseAsset]
}

/// A raw HTTP response for the GitHub API seam.
public struct GhResponse: Sendable {
    public let status: Int
    public let body: [UInt8]
    public init(status: Int, body: [UInt8]) {
        self.status = status
        self.body = body
    }
    public var text: String { String(decoding: body, as: UTF8.self) }
    public var ok: Bool { status >= 200 && status < 300 }
}

/// The GitHub HTTP seam. `get` performs a single request; `download` streams a
/// body to disk. Defaults hit the network; tests inject a fake.
public protocol GhFetcher: Sendable {
    func get(_ url: String, headers: [String: String]) async throws -> GhResponse
}

/// Structured GitHub-release failures with the JS `code`s preserved.
public struct GhReleaseError: Error, Sendable, Equatable {
    public let message: String
    public let code: String
    public let status: Int?
    public init(message: String, code: String, status: Int? = nil) {
        self.message = message
        self.code = code
        self.status = status
    }
}

public enum GhRelease {
    /// GET /repos/<repo>/releases/latest and normalize the payload.
    public static func fetchLatest(_ repo: String, fetcher: any GhFetcher) async throws -> Release {
        let url = "https://api.github.com/repos/\(repo)/releases/latest"
        let response = try await fetcher.get(
            url, headers: ["Accept": "application/vnd.github+json", "User-Agent": userAgent])
        guard response.ok else {
            throw GhReleaseError(
                message: "releases/latest fetch failed: HTTP \(response.status)",
                code: "fetch-failed", status: response.status)
        }
        return try parseRelease(response.body)
    }

    /// Parse a GitHub release JSON payload → `Release`. Exposed for tests.
    public static func parseRelease(_ body: [UInt8]) throws -> Release {
        guard
            let object = try? JSONSerialization.jsonObject(with: Data(body)) as? [String: Any],
            let tag = object["tag_name"] as? String
        else {
            throw GhReleaseError(
                message: "releases/latest payload has no tag_name", code: "malformed")
        }
        let assets = (object["assets"] as? [[String: Any]] ?? [])
            .map { asset in
                ReleaseAsset(
                    name: asset["name"] as? String ?? "",
                    size: (asset["size"] as? Int) ?? 0,
                    url: asset["browser_download_url"] as? String ?? "")
            }
        return Release(
            tagName: tag, publishedAt: object["published_at"] as? String ?? "", assets: assets)
    }

    /// Pick the snapshot archive by suffix preference (.tar.zst → .tar.gz → .7z)
    /// and its `<name>.sha256` sidecar. Throws when either is absent.
    public static func pickSnapshotAssets(_ release: Release, tier: String = "full") throws -> (
        archive: ReleaseAsset, checksum: ReleaseAsset
    ) {
        func find(_ ext: String) -> ReleaseAsset? {
            release.assets.first { $0.name.contains("-\(tier)-") && $0.name.hasSuffix(ext) }
        }
        guard let archive = find(".tar.zst") ?? find(".tar.gz") ?? find(".7z") else {
            let available = release.assets.map(\.name).joined(separator: ", ")
            throw GhReleaseError(
                message:
                    "release \(release.tagName) has no -\(tier)- archive (available: "
                    + "\(available.isEmpty ? "none" : available))", code: "no-archive")
        }
        let sidecarName = "\(archive.name).sha256"
        guard let checksum = release.assets.first(where: { $0.name == sidecarName }) else {
            throw GhReleaseError(
                message:
                    "release \(release.tagName) ships \(archive.name) without a matching .sha256 "
                    + "sidecar.", code: "no-checksum")
        }
        return (archive, checksum)
    }

    /// Fetch a `.sha256` sidecar and return the 64-char lowercase hex digest.
    public static func fetchSha256Sidecar(_ url: String, fetcher: any GhFetcher) async throws
        -> String
    {
        let response = try await fetcher.get(url, headers: ["User-Agent": userAgent])
        guard response.ok else {
            throw GhReleaseError(
                message: "sidecar fetch failed: HTTP \(response.status) for \(url)",
                code: "sidecar-failed", status: response.status)
        }
        guard let digest = leadingSha256Hex(response.text) else {
            throw GhReleaseError(
                message: "sidecar at \(url) did not start with a 64-char hex digest",
                code: "sidecar-malformed")
        }
        return digest
    }

    /// Download a URL and verify its sha256, writing to `destPath` on success
    /// (via the atomic filesystem). Throws `checksum-mismatch` on divergence.
    @discardableResult
    public static func downloadAndVerify(
        _ url: String, to destPath: String, expectedSha256: String, fetcher: any GhFetcher,
        fs: any OpsFileSystem
    ) async throws -> (bytes: Int, sha256: String) {
        let response = try await fetcher.get(url, headers: ["User-Agent": userAgent])
        guard response.ok else {
            throw GhReleaseError(
                message: "download failed: HTTP \(response.status) for \(url)",
                code: "download-failed", status: response.status)
        }
        let actual = SHA256Hex.hex(response.body)
        guard actual == expectedSha256.lowercased() else {
            throw GhReleaseError(
                message:
                    "sha256 mismatch for \(url): expected \(prefix16(expectedSha256))..., got "
                    + "\(prefix16(actual))...", code: "checksum-mismatch")
        }
        try fs.writeAtomic(destPath, response.body)
        return (response.body.count, actual)
    }

    /// Channel-aware resolution. `stable` → `fetchLatest`. `beta` requires the JS
    /// setup --beta macOS-base policy (src/commands/setup/helpers.js), which is
    /// not ported here — the CLI passes a resolver seam; absent it, beta errors.
    public static func resolveChannelRelease(
        _ repo: String, channel: String, fetcher: any GhFetcher,
        betaResolver: (@Sendable () async throws -> Release)? = nil
    ) async throws -> Release {
        if channel != "beta" { return try await fetchLatest(repo, fetcher: fetcher) }
        guard let betaResolver else {
            throw GhReleaseError(
                message: "beta channel resolution requires the setup --beta policy (not ported)",
                code: "beta-resolution-failed")
        }
        return try await betaResolver()
    }
}

/// The strict tag-name allowlist pull-snapshot enforces before stamping a tag to
/// disk (`^[A-Za-z0-9._-]{1,64}$`).
public func isValidSnapshotTag(_ tag: String) -> Bool {
    guard (1 ... 64).contains(tag.count) else { return false }
    return tag.unicodeScalars.allSatisfy { scalar in
        (scalar >= "A" && scalar <= "Z") || (scalar >= "a" && scalar <= "z")
            || (scalar >= "0" && scalar <= "9") || scalar == "." || scalar == "_" || scalar == "-"
    }
}

// MARK: - helpers

/// The leading 64-char hex run of a shasum-style sidecar (`<digest>  <file>`).
private func leadingSha256Hex(_ text: String) -> String? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    var hex = ""
    for scalar in trimmed.unicodeScalars {
        let isHex =
            (scalar >= "0" && scalar <= "9") || (scalar >= "a" && scalar <= "f")
            || (scalar >= "A" && scalar <= "F")
        guard isHex else { break }
        hex.unicodeScalars.append(scalar)
        if hex.count == 64 { break }
    }
    return hex.count == 64 ? hex.lowercased() : nil
}

private func prefix16(_ value: String) -> String { String(value.prefix(16)) }
