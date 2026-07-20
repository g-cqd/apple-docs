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

import ADJSONCore
import ADStorage
import ADWebBuild
import ADServeCore
import ADServeDSL
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

/// Bridges a corpus `StorageConnection` to the ADWebBuild landing-page inputs — the
/// essentials subset of ad-cli's `StorageCorpusReader` (`ADCLI/WebBuild.swift`), the
/// three reads the served shells need. Held per-request over the leased connection.
struct StorageWebReader {
    let connection: StorageConnection

    /// The homepage ROSTER (buildHomepageProps): `getRoots()` minus roots whose only
    /// page is the root itself (`page_count <= 1` AND the pages probe returns at most
    /// the self page). Byte-for-byte the ad-cli adapter's `homepageRoots()`.
    func homepageFrameworks() -> [IndexFramework] {
        connection.webBuildRoots()
            .filter { root in
                if root.pageCount <= 1 {
                    let pages = connection.frameworkPageDocs(root: root.slug)
                    if pages.count <= 1 && (pages.first == nil || pages.first?.path == root.slug) {
                        return false
                    }
                }
                return true
            }
            // No count badge: `roots` has no doc_count column, so the JS homepage's
            // `fw.doc_count` is always undefined (docCount: nil).
            .map { IndexFramework(kind: $0.kind, slug: $0.slug, displayName: $0.displayName, docCount: nil) }
    }

    /// The `/fonts` embedded payload — `JSON.stringify(db.listAppleFonts())`
    /// byte-parity via the stringify twin, re-parsed so the template re-encodes the
    /// identical bytes. The ad-cli adapter's `fontFamilies()`.
    func fontFamilies() -> JSON? {
        let families = connection.appleFontFamilyRows().map { $0.map(Self.fontRow) }
        let files = connection.appleFontFileRows().map { $0.map(Self.fontRow) }
        guard let text = BuildSite.fontsFamiliesJson(families: families, files: files) else { return nil }
        return try? ADJSON.parse(text, options: .init(maxDepth: 512)).root
    }

    /// `SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope`.
    func symbolTotals() -> [(scope: String, count: Int)] { connection.symbolScopeTotals() }

    private static func fontRow(_ row: DynamicRow) -> FontRow {
        FontRow(
            cells: row.cells.map { cell in
                let value: FontCell
                switch cell.value {
                    case .text(let s): value = .text(s)
                    case .integer(let i): value = .integer(i)
                    case .real(let d): value = .real(d)
                    case .null: value = .null
                }
                return (name: cell.name, value: value)
            })
    }
}

/// The landing-page handlers. Each renders one ADWebBuild page to `text/html;
/// charset=utf-8`, status 200 — non-hashable (no ETag / no Cache-Control), exactly
/// like the Bun `pages.route.js` shells; the engine still applies the cross-cutting
/// envelope (security headers, `Link`, `Vary`).
enum WebPages {
    /// `/` + `/index.html` — the homepage roster. Reads the filtered framework
    /// roster + the synthetic Fonts/Symbols design tiles.
    static func homePage(_ ctx: StorageContext, _ config: ADWebBuild.SiteConfig) -> ResponseContent {
        let frameworks = StorageWebReader(connection: ctx.db).homepageFrameworks()
        let html = LandingPages.renderIndexPage(frameworks, config, extras: BuildSite.homepageExtras(config))
        return .html(Array(html.utf8))
    }

    /// `/search` — the search landing shell. Pure `SiteConfig` (results are
    /// client-fetched from `/api/search`); no corpus read.
    static func searchPage(_ config: ADWebBuild.SiteConfig) -> ResponseContent {
        .html(Array(LandingPages.renderSearchPage(config).utf8))
    }

    /// `/fonts` — the Apple fonts page (embeds `listAppleFonts()` JSON).
    static func fontsPage(_ ctx: StorageContext, _ config: ADWebBuild.SiteConfig) -> ResponseContent {
        let families = StorageWebReader(connection: ctx.db).fontFamilies()
        return .html(Array(LandingPages.renderFontsPage(config, families: families).utf8))
    }

    /// `/symbols` + `/symbols/<name>` — the SF Symbols page. Bun serves the SAME
    /// client-rendered shell for every `/symbols/…` URL (the grid + per-symbol
    /// detail are fetched from `/api/symbols/*`); only the scope totals are embedded.
    static func symbolsPage(_ ctx: StorageContext, _ config: ADWebBuild.SiteConfig) -> ResponseContent {
        let totals = StorageWebReader(connection: ctx.db).symbolTotals()
        return .html(Array(LandingPages.renderSymbolsPage(config, totals: totals).utf8))
    }
}

/// Matches `/symbols/<name>` (the Bun `/^\/symbols\/.+$/` pattern) — every path
/// under `/symbols/` (incl. the bare trailing slash) serves the symbols shell. The
/// exact `/symbols` route handles the no-slash form; `/api/symbols/*` never has the
/// `/symbols/` prefix, so there is no collision.
func matchSymbolsPagePath(_ path: Substring) -> Bool? {
    path.hasPrefix("/symbols/") ? true : nil
}
