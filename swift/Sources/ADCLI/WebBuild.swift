// `ad-cli web build` — the native static-site build (P7 / WS-C). Opens the corpus
// read-only, bridges it to the ADWebBuild orchestrator via a `CorpusReader`
// adapter, and writes the artifact tree. This first slice emits the site
// essentials (landing + discovery + per-framework metadata + manifest); the
// per-document render loop + search/sitemap/assets are stubbed (logged to stderr
// from the BuildResult ledger). Parity oracle: `bun run cli.js web build`.

import ADArchive
import ADBase
import ADContent
import ADJSONCore
import ADStorage
import ADWebBuild
import ArgumentParser
import Foundation
import OrderedCollections

/// Bridges a corpus `StorageConnection` to the build's `CorpusReader`.
struct StorageCorpusReader: CorpusReader {
    let connection: StorageConnection

    /// `db.getRoots()` — EVERY root in slug order (the build walk); the
    /// per-framework metadata documentCount is build.js step 8's
    /// `COUNT(*) FROM documents WHERE framework = slug`.
    func corpusRoots() -> [CorpusRoot] {
        connection.webBuildRoots().map {
            CorpusRoot(
                slug: $0.slug, displayName: $0.displayName, kind: $0.kind,
                documentCount: connection.documentCount(framework: $0.slug),
                sourceType: $0.sourceType, url: nil)
        }
    }

    /// buildHomepageProps' roster: getRoots minus roots whose ONLY page is the
    /// root itself (`page_count <= 1` AND the pages probe returns at most the
    /// self page).
    func homepageRoots() -> [CorpusRoot] {
        connection.webBuildRoots().filter { root in
            if root.pageCount <= 1 {
                let pages = connection.frameworkPageDocs(root: root.slug)
                if pages.count <= 1 && (pages.first == nil || pages.first?.path == root.slug) {
                    return false
                }
            }
            return true
        }.map {
            CorpusRoot(
                slug: $0.slug, displayName: $0.displayName, kind: $0.kind,
                documentCount: connection.documentCount(framework: $0.slug),
                sourceType: $0.sourceType, url: nil)
        }
    }

    /// The /fonts embedded payload — `JSON.stringify(db.listAppleFonts())`
    /// byte-parity: full rows in SELECT * column order through the stringify
    /// twin, then parsed so the template re-encodes the identical bytes.
    func fontFamilies() -> JSON? {
        let families = connection.appleFontFamilyRows().map { $0.map(Self.fontRow) }
        let files = connection.appleFontFileRows().map { $0.map(Self.fontRow) }
        guard let text = BuildSite.fontsFamiliesJson(families: families, files: files) else { return nil }
        return try? ADJSON.parse(text, options: .init(maxDepth: 512)).root
    }

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

    func symbolTotals() -> [(scope: String, count: Int)] { connection.symbolScopeTotals() }

    /// The S4 sitemap walk: every root (getRoots ORDER BY slug) with its
    /// `key, role_heading` doc rows.
    func sitemapRoots() -> [SitemapRoot] {
        connection.sitemapRoots().map { root in
            SitemapRoot(
                slug: root.slug, kind: root.kind,
                docs: connection.sitemapDocs(framework: root.slug).map {
                    SitemapDoc(key: $0.key, roleHeading: $0.roleHeading)
                })
        }
    }

    /// The S3 search-artifact reads (generateSearchArtifacts' corpus surface):
    /// the columnar title index, the alias rows in table order, and the
    /// per-document body previews (accumulated + capped in ADStorage).
    func searchCorpus() -> SearchCorpus {
        let title = connection.buildTitleIndex()
        let source = connection.bodyPreviewSource()
        return SearchCorpus(
            titleIndex: TitleIndexData(
                frameworks: title.frameworks, keys: title.keys, titles: title.titles,
                abstracts: title.abstracts, fwIndices: title.fwIndices, kinds: title.kinds,
                roleHeadings: title.roleHeadings),
            aliases: connection.aliasEntries().map { (alias: $0.alias, canonical: $0.canonical) },
            hasSections: source.hasSections,
            shardDocs: source.docs.map { ShardDoc(key: $0.key, framework: $0.framework, body: $0.body) })
    }
}

/// The FULL-build reader: `StorageCorpusReader` + the document render loop's
/// enumerators (document-pages.js / framework-pages.js / render-cache.js).
/// The ancestor-title and role-heading indexes are precomputed once (the JS
/// render cache's O(N)-once tradeoff) — this reader is only constructed for
/// non-`--skip-docs` builds.
struct StorageDocumentReader: DocumentCorpusReader {
    let base: StorageCorpusReader
    let titleIndex: [String: String]
    let roleIndex: [String: String]

    init(base: StorageCorpusReader) {
        self.base = base
        self.titleIndex = base.connection.ancestorTitleIndex()
        self.roleIndex = base.connection.roleHeadingIndex()
    }

    // CorpusReader — delegate to the essentials adapter.
    func corpusRoots() -> [CorpusRoot] { base.corpusRoots() }
    func homepageRoots() -> [CorpusRoot] { base.homepageRoots() }
    func fontFamilies() -> JSON? { base.fontFamilies() }
    func symbolTotals() -> [(scope: String, count: Int)] { base.symbolTotals() }

    func knownKeys() -> Set<String> { base.connection.knownDocumentKeys() }

    /// The per-framework enumerator: document rows (ORDER BY id) + each doc's
    /// sections (ORDER BY sort_order, id — identical to batchFetchSections'
    /// per-doc sequence) + its ancestor-title map.
    func documents(inFramework slug: String) -> [BuildDocument] {
        base.connection.webBuildDocuments(framework: slug).map { row in
            let sections = base.connection.documentSections(row.key).map { section in
                DocSection(
                    sectionKind: section.sectionKind, heading: section.heading,
                    contentText: section.contentText, contentJson: section.contentJSON,
                    sortOrder: section.sortOrder)
            }
            let doc = DocRecord(
                key: row.key, title: row.title, framework: row.framework,
                frameworkDisplay: row.frameworkDisplay, roleHeading: row.roleHeading,
                isDeprecated: row.isDeprecated, isBeta: row.isBeta, platformsJson: row.platformsJson,
                url: row.url, abstractText: row.abstractText, language: row.language)
            return BuildDocument(doc: doc, sections: sections, ancestorTitles: ancestorTitles(for: row.key), id: row.id)
        }
    }

    /// render-cache.js `getAncestorTitles(key)`: for i in 1..<segs.count-1,
    /// the title of segs[0...i].joined("/") when indexed.
    private func ancestorTitles(for key: String) -> [String: String] {
        let segs = key.split(separator: "/").map(String.init)  // split(...).filter(Boolean)
        guard segs.count > 2 else { return [:] }
        var titles: [String: String] = [:]
        for i in 1..<(segs.count - 1) {
            let partial = segs[0...i].joined(separator: "/")
            if let title = titleIndex[partial] { titles[partial] = title }
        }
        return titles
    }

    /// `getPagesByRoot` rows as the [JSON] the framework page renders — built
    /// through the stringify twin (explicit null members, like the JS row
    /// objects) and re-parsed.
    func frameworkPageDocuments(slug: String) -> [JSON] {
        let rows = base.connection.frameworkPageDocs(root: slug)
        guard !rows.isEmpty else { return [] }
        let text = BuildSite.frameworkDocsJson(
            rows.map {
                FrameworkListingDoc(
                    path: $0.path, title: $0.title, role: $0.role, roleHeading: $0.roleHeading,
                    abstract: $0.abstract, sourceMetadata: $0.sourceMetadata, framework: $0.framework)
            })
        guard let root = try? ADJSON.parse(text, options: .init(maxDepth: 512)).root else { return [] }
        return root.arrayValue
    }

    func frameworkTreeEdges(slug: String) -> [(fromKey: String, toKey: String)] {
        base.connection.frameworkTreeEdges(slug).map { (fromKey: $0.fromKey, toKey: $0.toKey) }
    }


    /// scope-group-data.js `loadScopeExtras(db, root)`: the HIG topic→category
    /// map for the `design` root (most-specific parent wins; category order
    /// from the HIG landing page's children), empty for every other slug.
    func scopeExtras(slug: String) -> ScopeExtras {
        guard slug == "design" else { return ScopeExtras() }
        let data = base.connection.higCategoryRows()
        var orderIndex: [String: Int] = [:]
        for (index, key) in data.order.enumerated() where orderIndex[key] == nil {
            orderIndex[key] = index
        }
        var groups: [String: HigGroup] = [:]
        for row in data.rows {
            if row.parent == "design/human-interface-guidelines" { continue }
            if let existing = groups[row.child], existing.parentPath.count >= row.parent.count {
                continue
            }
            groups[row.child] = HigGroup(
                label: row.parentTitle ?? row.parent, parentPath: row.parent,
                order: orderIndex[row.parent] ?? orderIndex.count + 1)
        }
        return ScopeExtras(higGroups: groups)
    }

    /// render-cache.js `getRoleHeadings(keys)` — only found entries.
    func roleHeadings(forKeys keys: [String]) -> [String: String] {
        var out: [String: String] = [:]
        for key in keys {
            if let heading = roleIndex[key] { out[key] = heading }
        }
        return out
    }
}

/// Writes the artifact tree under `outDir` (creating parent directories).
struct FileArtifactSink {
    let outDir: String

    func ensureDir(_ relative: String) throws {
        let path = relative.isEmpty ? outDir : "\(outDir)/\(relative)"
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    }

    func write(_ artifact: Artifact) throws {
        let path = "\(outDir)/\(artifact.path)"
        let dir = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        guard FileManager.default.createFile(atPath: path, contents: Data(artifact.bytes)) else {
            throw ValidationError("ad-cli: failed to write \(path)")
        }
    }
}

/// Random lowercase hex (`randomBytes(n).toString('hex')`).
func randomHex(_ bytes: Int) -> String {
    (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
}

/// The native template-surface stamp: sha256("path|size|mtimeNs")[:16] of the
/// running ad-cli binary. The JS hashes its template FILES; the compiled binary
/// IS the native template surface, so any rebuild rotates the version —
/// over-invalidation (a full re-render after every binary change), never a
/// stale skip. Size+mtime instead of content keeps the stamp O(1).
func nativeTemplateVersion() -> String {
    let path = CommandLine.arguments.first ?? "ad-cli"
    var size: Int64 = 0
    var mtime: Double = 0
    if let attrs = try? FileManager.default.attributesOfItem(atPath: path) {
        size = (attrs[.size] as? NSNumber)?.int64Value ?? 0
        mtime = (attrs[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
    }
    return String(ADBase.Sha256.hexString("\(path)|\(size)|\(mtime)").prefix(16))
}

/// The document-pages.js two-tier incremental skip + upsert, bound to the
/// writable connection. Skip: render-index digest match AND the on-disk file
/// exists (template_version drift alone refreshes the entry instead of
/// re-rendering). didRender persists the new entry.
func renderIndexHooks(
    _ writer: StorageConnection, templateVersion: String, buildDir: String, isIncremental: Bool
) -> IncrementalHooks {
    IncrementalHooks(
        shouldSkip: { docId, digest, relativePath in
            guard isIncremental, docId != 0 else { return false }
            let filePath = "\(buildDir)/\(relativePath)"
            guard FileManager.default.fileExists(atPath: filePath) else { return false }
            guard let cached = writer.renderIndexEntry(docId: docId), cached.sectionsDigest == digest
            else { return false }
            if cached.templateVersion != templateVersion {
                _ = writer.upsertRenderIndexEntry(
                    docId: docId, sectionsDigest: digest, templateVersion: templateVersion,
                    htmlHash: cached.htmlHash, updatedAt: Int64(Date().timeIntervalSince1970))
            }
            return true
        },
        didRender: { docId, digest, htmlHash in
            guard docId != 0 else { return }
            _ = writer.upsertRenderIndexEntry(
                docId: docId, sectionsDigest: digest, templateVersion: templateVersion,
                htmlHash: htmlHash, updatedAt: Int64(Date().timeIntervalSince1970))
        })
}

/// setWebBuildCheckpoint — the JSON state row (build.js's object shape,
/// insertion order preserved).
func writeCheckpoint(
    _ writer: StorageConnection, runId: String, templateVersion: String, startedAt: Int64,
    built: Int, skipped: Int, buildDir: String, baseUrl: String, incremental: Bool, status: String
) {
    let state = JSONValue.obj([
        ("run_id", .string(runId)),
        ("template_version", .string(templateVersion)),
        ("started_at", .int(startedAt)),
        ("updated_at", .int(Int64(Date().timeIntervalSince1970))),
        ("pages_built", .int(Int64(built))),
        ("pages_skipped", .int(Int64(skipped))),
        ("pages_failed", .int(0)),
        ("build_dir", .string(buildDir)),
        ("base_url", .string(baseUrl)),
        ("incremental", .bool(incremental)),
        ("status", .string(status)),
    ])
    let json = String(decoding: (try? state.encodedBytes(options: .javaScript)) ?? [], as: UTF8.self)
    _ = writer.setSyncCheckpoint(key: "web_build", valueJSON: json, updatedAt: jsIsoNow())
}

/// atomic-swap.js `atomicPublish`: out→prev, tmp→out, rm prev; a failed second
/// rename restores prev before rethrowing.
func atomicPublish(outDir: String, buildDir: String, previousDir: String) throws {
    let fileManager = FileManager.default
    var hadPrevious = false
    if fileManager.fileExists(atPath: outDir) {
        try fileManager.moveItem(atPath: outDir, toPath: previousDir)
        hadPrevious = true
    }
    do {
        try fileManager.moveItem(atPath: buildDir, toPath: outDir)
    } catch {
        if hadPrevious, fileManager.fileExists(atPath: previousDir), !fileManager.fileExists(atPath: outDir) {
            try? fileManager.moveItem(atPath: previousDir, toPath: outDir)
        }
        throw error
    }
    if hadPrevious {
        try? fileManager.removeItem(atPath: previousDir)
    }
}

/// `new Date().toISOString()` — ISO-8601 UTC with exactly 3 fractional digits
/// (e.g. `2026-07-02T12:34:56.789Z`), the search-manifest `generatedAt` form.
func jsIsoNow() -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: Date())
}

/// `APPLE_DOCS_COMMIT` env, else `git rev-parse --short HEAD`; nil when neither
/// yields a plausible sha. Mirrors src/lib/git-version.js `getCommitHash`
/// exactly: trim + lowercase, validate against `^[0-9a-f]{7,40}$`, and an
/// INVALID env value falls through to git rather than being used raw. The JS
/// anchors git at its module's repo root ("works regardless of the process
/// cwd"); the native twin anchors `-C` at the binary's own directory — a dev
/// build under swift/.build resolves the repo's .git the same way, and an
/// installed binary outside any repo returns nil, like a non-git JS install.
func gitCommitHash() -> String? {
    if let env = ProcessInfo.processInfo.environment["APPLE_DOCS_COMMIT"] {
        let cleaned = env.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if isCommitSha(cleaned) { return cleaned }
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
    return isCommitSha(hash) ? hash : nil
}

/// JS `SHA_RE = /^[0-9a-f]{7,40}$/` (post-lowercase, so bare `[0-9a-f]`).
private func isCommitSha(_ candidate: String) -> Bool {
    let scalars = candidate.unicodeScalars
    guard scalars.count >= 7 && scalars.count <= 40 else { return false }
    return scalars.allSatisfy { ("0"..."9").contains($0) || ("a"..."f").contains($0) }
}

/// `ad-cli web …` — the static-site build verb group.
struct WebCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "web", abstract: "Static documentation site build.",
        subcommands: [WebBuildCommand.self])
}

/// `ad-cli web build --db <PATH> [--out dist/web] [--base-url …] [--site-name …]`.
struct WebBuildCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "build",
        abstract: "Build the static site essentials (per-document render loop is WIP).")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Output directory.")
    var out: String = "dist/web"

    @Option(name: .customLong("base-url"), help: "Public base URL used in templates.")
    var baseUrl: String = ""

    @Option(name: .customLong("site-name"), help: "Site name.")
    var siteName: String = "Apple Developer Docs"

    @Option(name: .customLong("app-version"), help: "Package version (for the MCP server card).")
    var appVersion: String?

    @Option(
        name: .customLong("src-web"),
        help: "The src/web checkout holding the static assets (style.css, JS bundles, public/).")
    var srcWeb: String = "src/web"

    @Flag(name: .customLong("skip-docs"), help: "Build only site essentials; skip the per-document render loop.")
    var skipDocs = false

    @Flag(name: .long, help: "Incremental: write in place and skip unchanged documents (render index).")
    var incremental = false

    @Flag(name: .long, help: "Force a full rebuild (clears the render index; wins over --incremental).")
    var full = false

    @Option(
        name: .customLong("links-audit-json"),
        help: "Write the link-audit stats (linksAudit's return object) to this path — parity-gate tooling.")
    var linksAuditJson: String?

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            throw ExitCode(1)
        }
        // The incremental cache writes (render index + checkpoint) go through a
        // second, UNguarded connection — build.js writes these on every build.
        // A corpus without the tables (or a read-only medium) degrades to a
        // full render (the accessors no-op).
        let writer = StorageConnection(path: corpus.db, writable: true)
        let isIncremental = incremental && !full
        // build.js: full builds stage into a crypto-suffixed tmp dir and
        // atomically swap; incremental writes IN PLACE.
        let stamp = "\(Int(Date().timeIntervalSince1970 * 1000))-\(randomHex(8))"
        let buildDir = isIncremental ? out : "\(out).tmp-\(stamp)"
        let previousDir = "\(out).prev-\(stamp)"
        let buildDate = String(ISO8601DateFormatter().string(from: Date()).prefix(10))
        // Footer stamps — `snapshot_tag` (or `snapshot_version`) + `build_macos`
        // from snapshot_meta, and the short git commit (env override first), the
        // same sources the JS build reads.
        let snapshotTag = connection.snapshotMeta("snapshot_tag") ?? connection.snapshotMeta("snapshot_version")
        let config = SiteConfig(
            baseUrl: baseUrl, siteName: siteName, bundled: true, buildDate: buildDate,
            snapshotTag: snapshotTag, buildMacos: connection.snapshotMeta("build_macos"),
            commitHash: gitCommitHash())
        let reader = StorageCorpusReader(connection: connection)
        let sink = FileArtifactSink(outDir: buildDir)

        // build.js step order: 1 dirs → 2 asset pipeline → 4 landing/discovery
        // (which win over any stale public/ copy of the same name) → 8/9
        // metadata + manifest.
        for dir in BuildSite.directories { try sink.ensureDir(dir) }

        let bundler = resolveJsBundler()
        let assetSource = FileAssetSource(srcWebDir: srcWeb, bundler: bundler)
        let assetArtifacts = try BuildSite.planAssets(source: assetSource)
        for artifact in assetArtifacts { try sink.write(artifact) }

        // 7. Search artifacts (build.js runs this on every unfiltered build,
        // --skip-docs included). generatedAt = `new Date().toISOString()`.
        let search = BuildSite.planSearchArtifacts(
            corpus: reader.searchCorpus(), generatedAt: jsIsoNow())
        for artifact in search.artifacts { try sink.write(artifact) }

        // 7b. Sitemaps: the gzip seam (ADArchive.Gzip over the system libz —
        // SETTINGS match Bun.gzipSync; bitstreams differ, see Gzip.swift's
        // byte-parity note, so the gate compares gunzipped content).
        guard Gzip.available else {
            throw ValidationError("ad-cli web build: system zlib not found — cannot write sitemaps/*.xml.gz")
        }
        let sitemaps = try BuildSite.planSitemaps(
            roots: reader.sitemapRoots(), baseUrl: baseUrl, buildDate: buildDate)
        for file in sitemaps {
            if file.gzipped {
                guard let compressed = Gzip.compress(Array(file.xml.utf8)) else {
                    throw ValidationError("ad-cli web build: gzip failed for \(file.path)")
                }
                try sink.write(Artifact(path: file.path, bytes: compressed))
            } else {
                try sink.write(Artifact(path: file.path, text: file.xml))
            }
        }

        // The render index + checkpoint lifecycle (build.js initRenderIndexIfNeeded
        // + setWebBuildCheckpoint): --full clears the index; an incremental run
        // whose recorded template_version drifted clears it too. The native
        // template_version fingerprints the ad-cli binary (path|size|mtime →
        // sha256[:16]) — the JS hashes its template FILES; the binary IS the
        // native template surface, so any rebuild rotates the version
        // (over-invalidation, never staleness).
        let templateVersion = nativeTemplateVersion()
        let runStartedAt = Int64(Date().timeIntervalSince1970)
        if let writer {
            if !isIncremental {
                writer.clearRenderIndex()
            } else if let checkpoint = writer.syncCheckpoint(key: "web_build"),
                let parsed = parseJSONValue(checkpoint),
                case .object(let members) = parsed,
                case .string(let recorded)? = members["template_version"], recorded != templateVersion
            {
                FileHandle.standardError.write(
                    Data("ad-cli: template surface changed since last build — clearing render index\n".utf8))
                writer.clearRenderIndex()
            }
            writeCheckpoint(
                writer, runId: "\(runStartedAt)-\(randomHex(3))", templateVersion: templateVersion,
                startedAt: runStartedAt, built: 0, skipped: 0, buildDir: buildDir,
                baseUrl: baseUrl, incremental: isIncremental, status: "in_progress")
        }

        let result: BuildResult
        if skipDocs {
            result = try BuildSite.writeEssentials(
                config: config, reader: reader, version: appVersion, searchArtifacts: search.stats,
                ensureDir: { try sink.ensureDir($0) }, write: { try sink.write($0) })
        } else {
            // The full render loop (build.js steps 5/6 + the manifest-last
            // rule). markdownDocs mirrors the JS siteConfig flag
            // (`process.env.APPLE_DOCS_MARKDOWN_DOCS !== '0'`, default ON).
            // Highlighting = the shiki JSONL coprocess (build.js's
            // initHighlighter … disposeHighlighter bracket); Noop when bun /
            // the script is unavailable or APPLE_DOCS_NO_HIGHLIGHT=1.
            let docReader = StorageDocumentReader(base: reader)
            let markdownDocs = (ProcessInfo.processInfo.environment["APPLE_DOCS_MARKDOWN_DOCS"] ?? "") != "0"
            let highlighter = resolveHighlighter(srcWebDir: srcWeb)
            defer { highlighter?.coprocess.shutdown() }
            let hooks = writer.map { renderIndexHooks($0, templateVersion: templateVersion, buildDir: buildDir, isIncremental: isIncremental) }
            result = try BuildSite.writeAll(
                config: config, reader: docReader, version: appVersion, markdownDocs: markdownDocs,
                highlight: highlighter?.highlight, searchArtifacts: search.stats, incremental: hooks,
                ensureDir: { try sink.ensureDir($0) }, write: { try sink.write($0) })
        }

        var report = "ad-cli: built site\(skipDocs ? " essentials" : "") → \(out)\n"
        report += "ad-cli: assets via \(bundler.label) (\(assetArtifacts.count) artifacts)\n"

        // 10. Atomic publish (full builds only): rename out→prev, tmp→out,
        // rm prev; a failed swap restores prev (atomic-swap.js).
        if !isIncremental {
            try atomicPublish(outDir: out, buildDir: buildDir, previousDir: previousDir)
        }

        // Finalize the checkpoint (status completed + final counters).
        if let writer {
            writeCheckpoint(
                writer, runId: "\(runStartedAt)-\(randomHex(3))", templateVersion: templateVersion,
                startedAt: runStartedAt, built: result.pagesBuilt, skipped: result.pagesSkipped,
                buildDir: out, baseUrl: baseUrl, incremental: isIncremental, status: "completed")
        }

        // 11. Link audit — full unfiltered builds only (build.js:
        // `buildingAll && !skipDocs`). Classification failure of the WALK is a
        // build error; the stats land in the report (+ optionally on disk).
        if !skipDocs {
            let audit = try WebLinksAudit.run(outDir: out, connection: connection)
            report += "ad-cli: \(WebLinksAudit.summary(audit))\n"
            if let path = linksAuditJson {
                guard FileManager.default.createFile(
                    atPath: path, contents: Data(stringifyPretty(WebLinksAudit.json(audit)).utf8))
                else { throw ValidationError("ad-cli: cannot write \(path)") }
            }
        }

        if !result.stubs.isEmpty {
            report += "ad-cli: still stubbed (per the build ledger):\n"
            for stub in result.stubs { report += "  - \(stub)\n" }
        }
        FileHandle.standardError.write(Data(report.utf8))
    }
}
