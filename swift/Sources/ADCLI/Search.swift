// The `ad-cli search` verb — the native, fully-semantic search CLI. Mirrors
// cli.js's `search` dispatch byte-for-byte: builds SearchParams from the flags,
// loads the potion embedder (so the semantic tier is live, matching the JS CLI's
// default native-compute UX), runs the cascade with the semantic context, then
// prints either `formatSearchResults` (human) or the cascade's projected envelope
// (`--json`, = projectSearchResult). `--read` takes the top hit, runs the read
// `lookup` + pagination (ReadLookup.swift), and prints `formatSearchRead` /
// `{ hit, page }`.
//
// The query is `@Argument var query: [String]` joined with a single space: the
// JS flip pre-joins to one element, but the parity harness passes several
// positionals directly — both must yield the same joined string.

import ADJSONCore
import ADSearchCascade
import ADSemantic
import ADStorage
import ArgumentParser
import Foundation

struct SearchCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "search",
        abstract: "Search the docs (lexical cascade + live semantic tier), like cli.js search.")

    @Argument(help: "The search query (multiple words are joined with a single space).")
    var query: [String] = []

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Restrict to a framework/root slug (fuzzy-resolved).")
    var framework: String?
    @Option(name: .long, help: "Restrict to one or more source types (comma-separated).")
    var source: String?
    @Option(name: .long, help: "Restrict to a kind (e.g. symbol, article, struct).")
    var kind: String?
    @Option(name: .long, help: "Restrict to a language (swift / objc).")
    var language: String?
    @Option(name: .long, help: "Restrict to a platform (ios / macos / watchos / tvos / visionos).")
    var platform: String?
    @Option(name: .long, help: "Minimum iOS version.")
    var minIos: String?
    @Option(name: .long, help: "Minimum macOS version.")
    var minMacos: String?
    @Option(name: .long, help: "Minimum watchOS version.")
    var minWatchos: String?
    @Option(name: .long, help: "Minimum tvOS version.")
    var minTvos: String?
    @Option(name: .long, help: "Minimum visionOS version.")
    var minVisionos: String?
    @Option(name: .long, help: "Restrict WWDC results to a year.")
    var year: Int?
    @Option(name: .long, help: "Restrict to a WWDC track (substring match).")
    var track: String?
    @Option(name: .long, help: "Deprecated handling: include / exclude / only.")
    var deprecated: String?
    @Option(name: .long, help: "Maximum number of results (default 100).")
    var limit: Int?

    // cli.js search dispatch passes fuzzy/noDeep/noEager as toggles; they feed the
    // cascade's deep tiers. (The native cascade already honours them via prepare /
    // assemble; the flags ride through so the flip's surface matches.)
    @Flag(name: .long, help: "Disable the fuzzy (Levenshtein) tier.")
    var noFuzzy = false
    @Flag(name: .long, help: "Disable the deep (body) tier.")
    var noDeep = false
    @Flag(name: .long, help: "Force the body tier even when the window is filled.")
    var noEager = false

    @Flag(name: .long, help: "Read the top hit's content after searching.")
    var read = false
    @Option(name: .long, help: "With --read: paginate the content to N chars per page (floor 200).")
    var maxChars: Int?
    @Option(name: .long, help: "With --read: 1-based page number.")
    var page: Int?

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        guard let connection = StorageConnection(path: corpus.db) else {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(corpus.db)\n".utf8))
            throw ExitCode(1)
        }

        // The semantic context: load the potion embedder from <dbdir>/resources/
        // models/minishlab/potion-retrieval-32M (as SemanticProbe does). A failed
        // load degrades to lexical-only (semantic == nil) — the same graceful
        // degrade the JS `semanticCandidates(...).catch(() => [])` provides.
        let semantic = loadSearchSemanticContext(dbPath: corpus.db)

        let params = SearchParams(
            query: query.joined(separator: " "),
            limit: limit ?? 100,
            framework: framework, source: source, kind: kind, language: language, platform: platform,
            minIos: minIos, minMacos: minMacos, minWatchos: minWatchos, minTvos: minTvos,
            minVisionos: minVisionos, year: year, track: track, deprecated: deprecated)

        let outcome = Cascade.search(connection, params, semantic: semantic)

        // --read: the top hit + its content (JS `search --read`). An empty result
        // set falls back to the plain results formatter / envelope.
        if read, let top = outcome.hits.first {
            runReadMode(connection: connection, outcome: outcome, top: top)
            return
        }

        if json {
            print(prettyEnvelope(outcome.envelope))
        } else {
            print(formatSearchResults(outcome))
        }
    }

    /// `search --read` with a top hit: a PATH `lookup` of the hit + optional
    /// pagination, then `formatSearchRead` (human) / `{ hit, page }` (`--json`).
    private func runReadMode(connection: StorageConnection, outcome: SearchOutcome, top: SearchHitView) {
        let opts = LookupOptions(path: top.path, symbol: nil, framework: nil, section: nil)
        var pageResult = lookup(opts, connection, dataDir: (corpus.db as NSString).deletingLastPathComponent)
        if let maxChars, pageResult.found, let content = pageResult.content {
            pageResult = paginateCliContent(
                pageResult, content: content, maxChars: maxChars, pageNum: page ?? 1)
        }

        if json {
            // `{ hit: projectHit(hit), page: projectReadDoc(page, {full:true}) }`.
            let object = JSONValue.obj([
                ("hit", projectSearchHitJSON(top)),
                ("page", projectReadDoc(pageResult))
            ])
            print(stringifyPretty(object))
        } else {
            print(formatSearchRead(hit: top, page: pageResult))
        }
    }
}

/// The search `--json` output. cli.js prints `JSON.stringify(projectSearchResult
/// (result), null, 2)` — PRETTY (2-space). The cascade's `envelope` already IS
/// `projectSearchResult` (the allowlist + pinned key order), but serialized
/// COMPACT (the server wire format). Reparse it (object key order preserved) and
/// re-emit through `stringifyPretty`, which matches `JSON.stringify(v, null, 2)`
/// byte-for-byte — so the bytes equal the JS oracle's pretty output. A parse
/// failure (never expected — the cascade emits valid JSON) falls back to the
/// compact bytes.
private func prettyEnvelope(_ envelope: [UInt8]) -> String {
    let text = String(decoding: envelope, as: UTF8.self)
    guard let value = parseJSONValue(text) else { return text }
    return stringifyPretty(value)
}

// MARK: - human formatters (ported byte-for-byte from src/cli/formatters/search.js)

/// Port of `formatSearchResults(result)`. Reads the RAW hit (matchQuality /
/// distance), NOT the projected `confidence`. No trailing newline — `print` adds
/// the single `\n` (matching `console.log`).
func formatSearchResults(_ outcome: SearchOutcome) -> String {
    if outcome.hits.isEmpty {
        return "No results for \"\(outcome.query)\""
    }
    var lines: [String] = []
    // The native cascade never produces a top-level `relaxed` flag (the search
    // verb has no relaxed-tier surface), so the "best-effort matches" preamble
    // never fires — matching the oracle for these queries.
    for r in outcome.hits {
        let quality = r.matchQuality
        let tag = qualityBadge(quality, r.distance)
        let sourceLabel = r.sourceType.map { "\($0) / " } ?? ""
        let flags = [r.isDeprecated ? dim("[deprecated]") : "", r.isBeta ? dim("[beta]") : ""]
            .filter { !$0.isEmpty }
            .joined(separator: " ")
        let flagsSuffix = flags.isEmpty ? "" : " \(flags)"
        lines.append("  \(dim("\(sourceLabel + jsString(r.framework)) / \(r.kind ?? "")"))\(tag)\(flagsSuffix)")
        lines.append("  \(bold(jsString(r.title)))")
        if let abstract = r.abstract, !abstract.isEmpty { lines.append("  \(abstract)") }
        if let snippet = r.snippet, !snippet.isEmpty, snippet != r.abstract {
            lines.append("  \(dim(snippet))")
        }
        if (r.relatedCount ?? 0) > 0 { lines.append("  \(dim("↳ \(r.relatedCount ?? 0) related"))") }
        lines.append("  \(dim(r.path))")
        lines.append("")
    }
    let plural = outcome.total != 1 ? "s" : ""
    lines.append("\(outcome.total) result\(plural) for \"\(outcome.query)\"")
    return lines.joined(separator: "\n")
}

/// Port of `formatSearchRead({ hit, page })`. The "Match:" line appends `(d=<n>)`
/// only for a fuzzy hit (JS `quality === 'fuzzy'`).
func formatSearchRead(hit: SearchHitView, page: LookupResult) -> String {
    let quality = hit.matchQuality
    let distanceSuffix = quality == "fuzzy" ? " (d=\(hit.distance.map(String.init) ?? "undefined"))" : ""
    var lines = [
        "  \(dim("┌")) Best match: \(bold(jsString(hit.title)))",
        "  \(dim("│")) Source:     \(hit.sourceType ?? "unknown")",
        "  \(dim("│")) Framework:  \(jsString(hit.framework))",
        "  \(dim("│")) Match:      \(quality)\(distanceSuffix)",
        "  \(dim("└")) Path:       \(hit.path)",
        ""
    ]
    if !page.found || page.content == nil {
        lines.append(page.note ?? "Markdown not available.")
    } else {
        lines.append(page.content ?? "")
    }
    if let pageInfo = page.pageInfo {
        lines.append("")
        lines.append(
            dim("--- Page \(pageInfo.page)/\(pageInfo.totalPages) (\(pageInfo.strategy)) ---"))
        if pageInfo.hasNextPage {
            lines.append(dim("Next page: add --page \(pageInfo.page + 1)"))
        }
    }
    return lines.joined(separator: "\n")
}

/// Port of `qualityBadge(quality, distance)` (src/cli/formatters/_shared.js):
/// `''` for 'match'; ` [fuzzy d=<n>]` (dim) for 'fuzzy'; ` [relaxed]` (dim) for
/// the relaxed family; else ` [<quality>]` (dim). ('exact' falls to the default
/// → ` [exact]`; the JS does the same — only 'match' is suppressed.)
func qualityBadge(_ quality: String, _ distance: Int?) -> String {
    if quality == "match" { return "" }
    if quality == "fuzzy" { return dim(" [fuzzy d=\(distance.map(String.init) ?? "undefined")]") }
    if quality == "relaxed" || quality == "relaxed-or" || quality == "relaxed-token" {
        return dim(" [relaxed]")
    }
    return dim(" [\(quality)]")
}

// MARK: - --read --json hit projection (projectSearchHit, via ADJSON's JSONValue)

/// `projectSearchHit(hit)` for the `--read --json` `{ hit }` slot: the
/// SEARCH_HIT_KEEP allowlist (path, title, framework, rootSlug, kind, sourceType,
/// abstract, declaration, platforms, language, snippet, relatedCount) in order,
/// then `confidence`, then the truthy-only isDeprecated/isBeta/isReleaseNotes
/// flags. `pick` keeps a defined-but-null value as JSON `null` and omits an
/// undefined one; the rich search hit always carries these keys (snippet/
/// relatedCount only after enrichment), so the present-key set is mirrored here.
private func projectSearchHitJSON(_ h: SearchHitView) -> JSONValue {
    var pairs: [(String, JSONValue)] = [
        ("path", .string(h.path)),
        ("title", jOptionalSearch(h.title)),
        ("framework", jOptionalSearch(h.framework)),
        ("rootSlug", jOptionalSearch(h.rootSlug)),
        ("kind", jOptionalSearch(h.kind)),
        ("sourceType", jOptionalSearch(h.sourceType)),
        ("abstract", jOptionalSearch(h.abstract)),
        ("declaration", jOptionalSearch(h.declaration)),
        ("platforms", parseSearchPlatforms(h.platforms)),
        ("language", jOptionalSearch(h.language))
    ]
    if let snippet = h.snippet { pairs.append(("snippet", .string(snippet))) }
    if let relatedCount = h.relatedCount { pairs.append(("relatedCount", .int(Int64(relatedCount)))) }
    pairs.append(("confidence", .string(h.confidence)))
    if h.isDeprecated { pairs.append(("isDeprecated", .bool(true))) }
    if h.isBeta { pairs.append(("isBeta", .bool(true))) }
    if h.isReleaseNotes { pairs.append(("isReleaseNotes", .bool(true))) }
    return .obj(pairs)
}

/// The rich hit's `platforms` is the parsed `platforms_json` value, re-serialized
/// by `JSON.stringify`. We parse the raw JSON string and emit the value (object
/// OR array), or `[]` for a nil/empty/unparseable column (matching `formatResult`'s
/// `parsePlatformsString` → `[]` and the cascade's `rawOrEmptyArray`).
private func parseSearchPlatforms(_ json: String?) -> JSONValue {
    guard let json, !json.isEmpty, let value = parseJSONValue(json) else { return .array([]) }
    return value
}

/// An optional string as JSON: a value → string, nil → `null` (pick keeps nulls).
private func jOptionalSearch(_ value: String?) -> JSONValue {
    value.map(JSONValue.string) ?? .null
}

// MARK: - embedder loading for the search verb

/// Load the potion embedder for the search verb's semantic context, or nil to
/// degrade to lexical-only. Reuses `loadPotionEmbedder` (SemanticProbe.swift) with
/// the same `<dbdir>/resources/models/minishlab/potion-retrieval-32M` layout.
/// Returns nil — lexical-only — when `APPLE_DOCS_SEMANTIC=off` (mirroring the JS
/// `isSemanticAvailable` kill switch) or when the embedder fails to load (no model
/// dir / unreadable artifact), exactly like the JS embedder-absent path.
func loadSearchSemanticContext(dbPath: String) -> SemanticContext? {
    if ProcessInfo.processInfo.environment["APPLE_DOCS_SEMANTIC"] == "off" { return nil }
    let dataDir = (dbPath as NSString).deletingLastPathComponent
    let modelDir = dataDir + "/resources/models/minishlab/potion-retrieval-32M"
    guard let embedder = try? loadPotionEmbedder(modelDir: modelDir) else { return nil }
    return SemanticContext(embedder: embedder, topK: 50)
}
