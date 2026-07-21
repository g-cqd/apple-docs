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

import ADContent
import ADJSONCore
import ADStorage
import ADWebBuild
import ADServeCore
import ADServeDSL
import Foundation
// HTTPCore: the response-status enum (`.notFound`) MemberImportVisibility requires
// importing from its defining module (ADServe's engine re-based onto HTTP).
import HTTPCore
import Synchronization

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

/// The per-server page-render context: the ADWebBuild config, the markdown-docs
/// flag, and the lazily-read corpus link-resolution key set. Threaded through the
/// route table (built once in Main.swift). `Sendable` — shared across request
/// handlers, mutated only through the internal lock.
final class WebDocContext: Sendable {
    let config: ADWebBuild.SiteConfig
    /// `siteConfig.markdownDocs` — `APPLE_DOCS_MARKDOWN_DOCS != "0"` (default on).
    let markdownDocs: Bool
    private let knownKeysCache = Mutex<Set<String>?>(nil)

    init(config: ADWebBuild.SiteConfig, markdownDocs: Bool) {
        self.config = config
        self.markdownDocs = markdownDocs
    }

    /// The `SELECT key FROM documents` set the in-page link resolver needs, read
    /// once and cached for the process lifetime. The JS render cache keys the same
    /// set on the DB mtime; a read-only server never sees the corpus change under
    /// it (a corpus swap is a redeploy → restart), so a plain once-cache suffices.
    func knownKeys(_ conn: StorageConnection) -> Set<String> {
        knownKeysCache.withLock { cache in
            if let cached = cache { return cached }
            let keys = conn.knownDocumentKeys()
            cache = keys
            return keys
        }
    }
}

/// Assemble the page-render context once at startup (mirrors `src/web/context.js`).
func makeWebDocContext(serverConfig: SiteConfig, dbPath: String) -> WebDocContext {
    let markdownDocs = (ProcessInfo.processInfo.environment["APPLE_DOCS_MARKDOWN_DOCS"] ?? "") != "0"
    return WebDocContext(
        config: makeWebSiteConfig(serverConfig: serverConfig, dbPath: dbPath), markdownDocs: markdownDocs)
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

extension WebPages {
    /// `/docs/<key>` — dispatch: framework listing page (root slug) vs document
    /// page vs the rendered 404. Both pages are HASHABLE (text/html + content-hash
    /// ETag, no Cache-Control), as Bun's `HTML_HASHABLE`.
    static func docsPage(_ ctx: StorageContext, _ web: WebDocContext, key: String) -> ResponseContent {
        guard !key.isEmpty else { return notFoundPage(web.config) }
        let conn = ctx.db

        // Markdown via the `.md` URL suffix: `/docs/<key>.md` returns the same
        // rendered body MCP read_doc / `ad-cli read` serve. A distinct URL is a
        // distinct CDN cache key (vs `Accept` negotiation). Gated by markdownDocs.
        if web.markdownDocs && key.hasSuffix(".md") {
            let mdKey = String(key.dropLast(3))
            if let resolved = resolveDocument(path: mdKey, symbol: nil, framework: nil, conn: conn),
                let content = resolved.content
            {
                return markdownResponse(content)
            }
            return notFoundPage(web.config)
        }

        // Framework listing first (the Bun `getRootBySlug(key)` order): a root
        // whose pages aren't just the self-page.
        if let root = conn.webBuildRoot(slug: key) {
            let docs = conn.frameworkPageDocs(root: key)
            let isSelfRef = docs.count <= 1 && (docs.first?.path == key)
            if !isSelfRef && !docs.isEmpty {
                return frameworkPage(conn, root: root, docs: docs, config: web.config)
            }
        }

        // Document page.
        if let doc = conn.webBuildDocument(key: key) {
            return documentPage(conn, doc: doc, web: web)
        }
        // NOTE: the Bun on-demand-fetch-from-Apple path (429 / 503 + Retry-After)
        // needs corpus WRITES + the crawl pipeline — out of scope for the read-only
        // server; a missing doc renders the 404 page, as Bun's terminal
        // notFoundResponse. (Also unported: the resolveHashedWebKey retry for
        // `~<hex12>` overlong-segment keys — those only arise on real oversized keys.)
        return notFoundPage(web.config)
    }

    /// One document page — the writeAll doc-loop recipe for a single key
    /// (enrichTopicSections + DocPage.render, `highlight: nil`).
    private static func documentPage(
        _ conn: StorageConnection, doc: WebBuildDoc, web: WebDocContext
    ) -> ResponseContent {
        let rawSections = conn.documentSections(doc.key).map(docSection)
        let sections = BuildSite.enrichTopicSections(rawSections) { conn.roleHeadings(forKeys: $0) }
        // DEVIATION: code blocks render as the `<pre><code>` fallback (highlight:
        // nil). The build precomputes shiki highlighting (operator decision #2) and
        // Caddy serves those pre-built pages from dist; ad-server's on-demand render
        // is the un-highlighted fallback. The gate runs the build with
        // APPLE_DOCS_NO_HIGHLIGHT=1 so both sides emit identical plain code.
        let html = DocPage.render(
            doc: docRecord(doc), sections: sections, config: web.config,
            knownKeys: web.knownKeys(conn), ancestorTitles: ancestorTitles(conn, key: doc.key),
            markdownDocs: web.markdownDocs, highlight: nil)
        return .html(Array(html.utf8))
    }

    /// One framework listing page — reuses `planFrameworkPage` so the emitted
    /// `data-tree-src` hash matches the build (and the `/data/frameworks` route).
    private static func frameworkPage(
        _ conn: StorageConnection, root: WebBuildRoot, docs: [FrameworkPageDoc],
        config: ADWebBuild.SiteConfig
    ) -> ResponseContent {
        let framework = FrameworkRecord(
            slug: root.slug, displayName: root.displayName, kind: root.kind,
            sourceType: root.sourceType, url: nil)
        let pages = BuildSite.planFrameworkPage(
            framework: framework, documents: frameworkDocsJSON(docs), config: config,
            treeEdges: conn.frameworkTreeEdges(root.slug).map { (fromKey: $0.fromKey, toKey: $0.toKey) },
            scopeExtras: scopeExtras(conn, slug: root.slug))
        // planFrameworkPage returns [sidecar?, html]; the HTML is the last artifact
        // (the tree sidecar itself is served by the existing /data/frameworks route).
        return .html(pages.last?.bytes ?? [])
    }

    /// The rendered 404 page (text/html, status 404, non-hashable) — Bun's
    /// `notFoundResponse`.
    static func notFoundPage(_ config: ADWebBuild.SiteConfig) -> ResponseContent {
        .html(Array(LandingPages.renderNotFoundPage(config).utf8), status: .notFound)
    }

    /// Bun's `markdownResponse`: text/markdown + the token estimate + the
    /// day-long cache. Hashable via the route's `.etag`. `x-markdown-tokens` =
    /// `ceil(content.length / 4)` with JS String.length = UTF-16 code units.
    static func markdownResponse(_ content: String) -> ResponseContent {
        let tokens = (content.utf16.count + 3) / 4
        var headers = HTTPFields()
        headers.append(String(tokens), for: HTTPFieldName("x-markdown-tokens")!)
        headers.append(
            "public, max-age=86400, stale-while-revalidate=604800", for: HTTPFieldName("cache-control")!)
        return .full(
            body: Array(content.utf8), contentType: "text/markdown; charset=utf-8", status: .ok,
            headers: headers)
    }

    // MARK: - corpus-row → template-model mapping (identical to ad-cli's reader)

    private static func docRecord(_ w: WebBuildDoc) -> DocRecord {
        DocRecord(
            key: w.key, title: w.title, framework: w.framework, frameworkDisplay: w.frameworkDisplay,
            roleHeading: w.roleHeading, isDeprecated: w.isDeprecated, isBeta: w.isBeta,
            platformsJson: w.platformsJson, url: w.url, abstractText: w.abstractText, language: w.language)
    }

    private static func docSection(_ s: DocumentSectionRow) -> DocSection {
        DocSection(
            sectionKind: s.sectionKind, heading: s.heading, contentText: s.contentText,
            contentJson: s.contentJSON, sortOrder: s.sortOrder)
    }

    /// render-cache.js `getAncestorTitles(key)`: the titles of `segs[0...i]` for
    /// `i in 1..<segs.count-1` that are indexed (title not null).
    private static func ancestorTitles(_ conn: StorageConnection, key: String) -> [String: String] {
        let segs = key.split(separator: "/").map(String.init)
        guard segs.count > 2 else { return [:] }
        var partials: [String] = []
        for i in 1 ..< (segs.count - 1) { partials.append(segs[0 ... i].joined(separator: "/")) }
        return conn.titles(forKeys: partials)
    }

    /// `getPagesByRoot` rows → the `[JSON]` the framework page renders, through the
    /// stringify twin + re-parse (identical to ad-cli's frameworkPageDocuments).
    private static func frameworkDocsJSON(_ docs: [FrameworkPageDoc]) -> [JSON] {
        guard !docs.isEmpty else { return [] }
        let text = BuildSite.frameworkDocsJson(
            docs.map {
                FrameworkListingDoc(
                    path: $0.path, title: $0.title, role: $0.role, roleHeading: $0.roleHeading,
                    abstract: $0.abstract, sourceMetadata: $0.sourceMetadata, framework: $0.framework)
            })
        guard let root = try? ADJSON.parse(text, options: .init(maxDepth: 512)).root else { return [] }
        return root.arrayValue
    }

    /// scope-group-data.js `loadScopeExtras(db, root)` — the HIG topic→category map
    /// for the `design` root, empty elsewhere (identical to ad-cli's scopeExtras).
    private static func scopeExtras(_ conn: StorageConnection, slug: String) -> ScopeExtras {
        guard slug == "design" else { return ScopeExtras() }
        let data = conn.higCategoryRows()
        var orderIndex: [String: Int] = [:]
        for (index, key) in data.order.enumerated() where orderIndex[key] == nil { orderIndex[key] = index }
        var groups: [String: HigGroup] = [:]
        for row in data.rows {
            if row.parent == "design/human-interface-guidelines" { continue }
            if let existing = groups[row.child], existing.parentPath.count >= row.parent.count { continue }
            groups[row.child] = HigGroup(
                label: row.parentTitle ?? row.parent, parentPath: row.parent,
                order: orderIndex[row.parent] ?? orderIndex.count + 1)
        }
        return ScopeExtras(higGroups: groups)
    }
}

/// Matches `/docs/<key>` (the Bun `/^\/docs\//` pattern) → the normalized corpus
/// key: strip the `/docs/` prefix, one trailing slash, then a trailing
/// `/index.html`. Returns "" for a bare `/docs/` (the handler renders the 404).
func matchDocsPath(_ path: Substring) -> String? {
    guard path.hasPrefix("/docs/") else { return nil }
    var key = String(path.dropFirst(6))
    if key.hasSuffix("/") { key = String(key.dropLast()) }
    if key.hasSuffix("/index.html") { key = String(key.dropLast(11)) }
    return key
}
