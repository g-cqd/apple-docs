// On-demand HTML page serving — the native twin of `src/web/routes/pages.route.js`
// (+ docs/assets in later slices). ad-server renders the SAME ADWebBuild page
// templates `ad-cli web build` writes to disk (already byte/DOM-identical to the
// Bun build), one page per request, over a StorageConnection-backed CorpusReader.
//
// Parity oracle: `bun cli.js web serve`. The one intentional deviation from the
// Bun serve path is the asset cache-buster: Bun's serve config stamps
// `assetVersion = Date.now().toString(36)` onto `/assets/*?v=…` (a per-process,
// non-deterministic query the static build omits). ad-server matches the static
// build instead — `assetVersion = nil`, deterministic asset URLs that Caddy
// serves from the immutable `dist/web/assets/` tree — so its output is
// byte-identical to `ad-cli web build` and stable across restarts.

import ADStorage
import ADWebBuild
import ADServeCore
import Foundation

/// The build-time site configuration the ADWebBuild page templates close over,
/// assembled once at server startup. Mirrors the `siteConfig` `ad-cli web build`
/// stamps (`ADCLI/WebBuild.swift`) and `src/web/context.js` assembles for serve:
/// `bundled: true`, today's `buildDate`, and the snapshot/commit footer
/// provenance — so a dynamically-served page matches the static build byte-for-byte.
///
/// `serverConfig` carries the ad-server flags (`--base-url`/`--site-name`/…);
/// snapshot provenance is read from the corpus once (a throwaway read-only open —
/// these values are constant for the process lifetime).
func makeWebSiteConfig(serverConfig: SiteConfig, dbPath: String) -> ADWebBuild.SiteConfig {
    let provenance = StorageConnection(path: dbPath)
    let snapshotTag =
        provenance?.snapshotMeta("snapshot_tag") ?? provenance?.snapshotMeta("snapshot_version")
    let buildMacos = provenance?.snapshotMeta("build_macos")
    return ADWebBuild.SiteConfig(
        baseUrl: serverConfig.baseUrl,
        siteName: serverConfig.siteName,
        // DEVIATION (documented above): the static build omits the cache-buster; we
        // match it, not Bun serve's non-deterministic `Date.now()` stamp.
        assetVersion: nil,
        bundled: true,
        buildDate: webBuildDate(),
        snapshotTag: snapshotTag,
        buildMacos: buildMacos,
        commitHash: webGitCommitHash(),
        contentSignal: serverConfig.contentSignal,
        searchShortName: serverConfig.searchShortName)
}

/// `new Date().toISOString().split('T')[0]` / the ad-cli build's
/// `ISO8601DateFormatter().string(from: Date()).prefix(10)` — today's UTC date.
private func webBuildDate() -> String {
    let formatter = ISO8601DateFormatter()
    return String(formatter.string(from: Date()).prefix(10))
}

/// The footer commit stamp — `APPLE_DOCS_COMMIT` env override (validated as a SHA),
/// else `git -C <binary-dir> rev-parse --short HEAD`. Byte-for-byte the ad-cli
/// build's `gitCommitHash()` (`ADCLI/WebBuild.swift`) and the JS `getCommitHash()`,
/// so all three agree at the same HEAD.
private func webGitCommitHash() -> String? {
    if let env = ProcessInfo.processInfo.environment["APPLE_DOCS_COMMIT"] {
        let cleaned = env.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if isWebCommitSha(cleaned) { return cleaned }
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    var arguments = ["git"]
    if let binary = Bundle.main.executablePath {
        arguments += ["-C", (binary as NSString).deletingLastPathComponent]
    }
    arguments += ["rev-parse", "--short", "HEAD"]
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return nil
    }
    guard process.terminationStatus == 0 else { return nil }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let hash = String(decoding: data, as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return isWebCommitSha(hash) ? hash : nil
}

/// JS `SHA_RE = /^[0-9a-f]{7,40}$/` (post-lowercase).
private func isWebCommitSha(_ candidate: String) -> Bool {
    let scalars = candidate.unicodeScalars
    guard scalars.count >= 7 && scalars.count <= 40 else { return false }
    return scalars.allSatisfy { ("0" ... "9").contains($0) || ("a" ... "f").contains($0) }
}

/// The landing-page handlers. Each renders one ADWebBuild page to `text/html;
/// charset=utf-8`, status 200 — non-hashable (no ETag / no Cache-Control), exactly
/// like the Bun `pages.route.js` shells; the engine still applies the cross-cutting
/// envelope (security headers, `Link`, `Vary`).
enum WebPages {
    /// `/search` — the search landing shell. Pure `SiteConfig` (results are
    /// client-fetched from `/api/search`); no corpus read.
    static func searchPage(_ config: ADWebBuild.SiteConfig) -> ResponseContent {
        .html(Array(LandingPages.renderSearchPage(config).utf8))
    }
}
