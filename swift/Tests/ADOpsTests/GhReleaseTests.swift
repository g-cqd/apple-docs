import Testing

@testable import ADOps

// Unit coverage for the GitHub-release helper (ops/lib/gh-release.js): payload
// parsing, snapshot-asset preference, sidecar parsing, tag validation, and the
// download+verify checksum gate — all over the injected fetcher (no network).

private let releaseJSON = """
    {
      "tag_name": "snapshot-2026.07.01",
      "published_at": "2026-07-01T06:00:00Z",
      "assets": [
        { "name": "apple-docs-full-2026.07.01.tar.gz", "size": 10, "browser_download_url": "https://x/full.tar.gz" },
        { "name": "apple-docs-full-2026.07.01.tar.zst", "size": 8, "browser_download_url": "https://x/full.tar.zst" },
        { "name": "apple-docs-full-2026.07.01.tar.zst.sha256", "size": 90, "browser_download_url": "https://x/full.tar.zst.sha256" }
      ]
    }
    """

private func parsed() throws -> Release {
    try GhRelease.parseRelease(Array(releaseJSON.utf8))
}

@Test func parseReleaseExtractsTagAndAssets() throws {
    let release = try parsed()
    #expect(release.tagName == "snapshot-2026.07.01")
    #expect(release.publishedAt == "2026-07-01T06:00:00Z")
    #expect(release.assets.count == 3)
    #expect(release.assets.contains { $0.url == "https://x/full.tar.zst" })
}

@Test func parseReleaseRejectsMissingTag() {
    let error = #expect(throws: GhReleaseError.self) {
        try GhRelease.parseRelease(Array("{\"assets\":[]}".utf8))
    }
    #expect(error?.code == "malformed")
}

@Test func pickPrefersZstThenChecksumSidecar() throws {
    let picked = try GhRelease.pickSnapshotAssets(parsed())
    #expect(picked.archive.name == "apple-docs-full-2026.07.01.tar.zst")
    #expect(picked.checksum.name == "apple-docs-full-2026.07.01.tar.zst.sha256")
}

@Test func pickFallsBackToTarGz() throws {
    let release = Release(
        tagName: "t", publishedAt: "",
        assets: [
            ReleaseAsset(name: "x-full-1.tar.gz", size: 1, url: "u"),
            ReleaseAsset(name: "x-full-1.tar.gz.sha256", size: 1, url: "u2")
        ])
    #expect(try GhRelease.pickSnapshotAssets(release).archive.name == "x-full-1.tar.gz")
}

@Test func pickThrowsWhenNoArchive() {
    let release = Release(tagName: "t", publishedAt: "", assets: [])
    let error = #expect(throws: GhReleaseError.self) { try GhRelease.pickSnapshotAssets(release) }
    #expect(error?.code == "no-archive")
}

@Test func pickThrowsWhenSidecarMissing() {
    let release = Release(
        tagName: "t", publishedAt: "",
        assets: [ReleaseAsset(name: "x-full-1.tar.zst", size: 1, url: "u")])
    let error = #expect(throws: GhReleaseError.self) { try GhRelease.pickSnapshotAssets(release) }
    #expect(error?.code == "no-checksum")
}

@Test func fetchLatestOverSeam() async throws {
    let fetcher = FakeGhFetcher { _ in GhResponse(status: 200, body: Array(releaseJSON.utf8)) }
    let release = try await GhRelease.fetchLatest("g-cqd/apple-docs", fetcher: fetcher)
    #expect(release.tagName == "snapshot-2026.07.01")
}

@Test func fetchLatestThrowsOnHttpError() async {
    let fetcher = FakeGhFetcher { _ in GhResponse(status: 404, body: []) }
    let error = await #expect(throws: GhReleaseError.self) {
        try await GhRelease.fetchLatest("g-cqd/apple-docs", fetcher: fetcher)
    }
    #expect(error?.code == "fetch-failed")
}

@Test func fetchSidecarParsesLeadingHex() async throws {
    let digest = String(repeating: "a", count: 64)
    let fetcher = FakeGhFetcher { _ in GhResponse(status: 200, body: Array("\(digest)  file.tar.zst\n".utf8)) }
    #expect(try await GhRelease.fetchSha256Sidecar("https://x/s.sha256", fetcher: fetcher) == digest)
}

@Test func downloadVerifiesChecksumAndWrites() async throws {
    let payload = Array("snapshot-bytes".utf8)
    let expected = SHA256Hex.hex(payload)
    let fetcher = FakeGhFetcher { _ in GhResponse(status: 200, body: payload) }
    let fs = MemoryFileSystem()
    let result = try await GhRelease.downloadAndVerify(
        "https://x/a.tar.zst", to: "/tmp/a.tar.zst", expectedSha256: expected, fetcher: fetcher, fs: fs)
    #expect(result.sha256 == expected)
    #expect(fs.tryRead("/tmp/a.tar.zst") == payload)
}

@Test func downloadThrowsOnChecksumMismatch() async {
    let fetcher = FakeGhFetcher { _ in GhResponse(status: 200, body: Array("real".utf8)) }
    let fs = MemoryFileSystem()
    let error = await #expect(throws: GhReleaseError.self) {
        try await GhRelease.downloadAndVerify(
            "https://x/a", to: "/tmp/a", expectedSha256: String(repeating: "0", count: 64),
            fetcher: fetcher, fs: fs)
    }
    #expect(error?.code == "checksum-mismatch")
    #expect(fs.tryRead("/tmp/a") == nil)  // nothing written on mismatch
}

@Test func snapshotTagValidation() {
    #expect(isValidSnapshotTag("snapshot-2026.07.01"))
    #expect(isValidSnapshotTag("v1.2.3"))
    #expect(!isValidSnapshotTag(""))
    #expect(!isValidSnapshotTag("has space"))
    #expect(!isValidSnapshotTag("../../etc/passwd"))
    #expect(!isValidSnapshotTag(String(repeating: "a", count: 65)))
}
