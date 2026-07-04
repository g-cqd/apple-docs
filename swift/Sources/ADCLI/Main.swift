// ad-cli — the native read CLI. The first slice of the P7 native CLI: two read
// verbs (`frameworks`, `kinds`) that mirror the Bun `cli.js` output 1:1 (the Bun
// CLI stays the parity oracle). Opens the corpus read-only via ADStorage and
// prints either the human formatter (Format.swift) or `JSON.stringify`-identical
// JSON (JsonBridge.swift, via ADJSON) when `--json` is passed. A separate target
// from ad-server because each needs its own `@main`.

import ADJSONCore
import ADStorage
import ADWebBuild
import ArgumentParser
import Foundation

@main
struct ADCLICommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ad-cli",
        abstract: "Apple Docs native read CLI (mirrors the Bun cli.js read verbs).",
        subcommands: [
            FrameworksCommand.self, KindsCommand.self, BrowseCommand.self, ReadCommand.self,
            SearchCommand.self, StatusCommand.self, CrawlCommand.self, SemanticProbeCommand.self,
            AddbWriteSpikeCommand.self, AddbReadSpikeCommand.self, WebCommand.self,
            IndexCommand.self, SyncCommand.self, SyncAllCommand.self, SnapshotCommand.self,
            VersionCommand.self,
            StorageCommand.self, OpsCommand.self
        ])
}

/// The corpus path — required by every verb. Mirrors ad-server's `CorpusOptions`.
struct CorpusOptions: ParsableArguments {
    @Option(name: .long, help: "Path to the corpus SQLite database.")
    var db: String

    func validate() throws {
        guard !db.isEmpty else { throw ValidationError("--db must not be empty") }
    }
}

/// Opens the corpus or exits 1 with a stderr message (the "cannot open db" contract).
private func openCorpus(_ path: String) -> StorageConnection {
    guard let connection = StorageConnection(path: path) else {
        FileHandle.standardError.write(Data("ad-cli: cannot open \(path)\n".utf8))
        exit(1)
    }
    return connection
}

/// The `browse` error contract: cli.js prints `Error: <message>` to stderr and
/// exits 1 with EMPTY stdout. Replicates that — call BEFORE any stdout output.
private func failBrowse(_ message: String) -> Never {
    FileHandle.standardError.write(Data("Error: \(message)\n".utf8))
    exit(1)
}

/// `ad-cli frameworks --db <PATH> [--kind <K>] [--json]` — list documentation
/// roots (live-page-count > 0, slug-ordered), grouped by kind.
struct FrameworksCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "frameworks", abstract: "List documentation roots.")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Filter by kind (e.g. framework, technology, tooling).")
    var kind: String?

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        let connection = openCorpus(corpus.db)
        // JS passes `opts.kind ?? null` raw to the bind (no trim); match exactly.
        let roots = connection.listFrameworkRoots(kind: kind)
        if json {
            print(stringifyPretty(projectFrameworks(roots)))
        } else {
            print(formatFrameworks(roots))
        }
    }
}

/// `ad-cli kinds --db <PATH> [--field <F>] [--json]` — taxonomy facet counts.
/// With a known `--field`, the targeted single-field shape; otherwise the broad
/// five-field shape (kind, role, docKind, roleHeading, sourceType), each top-20.
struct KindsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "kinds", abstract: "Taxonomy facet counts (kind/role/...).")

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Return one field only: kind, role, docKind, roleHeading, sourceType.")
    var field: String?

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        let connection = openCorpus(corpus.db)
        // JS: `opts?.field ? String(opts.field).trim() : null`. Empty after the
        // trim is treated as no field (falls to the broad shape).
        let trimmed = field.map(trimWhitespace)
        let selected = (trimmed?.isEmpty == false) ? trimmed : nil

        if let selected, let column = taxonomyColumn(for: selected) {
            // Targeted shape: `{ field, values }` — the per-field limit is always 20.
            let values = connection.taxonomyCounts(column: column, limit: taxonomyDefaultLimit)
            if json {
                print(stringifyPretty(.obj([(selected, taxonomyEntries(values))])))
            } else {
                print(formatTaxonomy([TaxonomySection(label: selected, values: values)]))
            }
            return
        }

        // Broad shape: all five fields IN ORDER, each top-20.
        let broad = broadTaxonomy(connection)
        if json {
            print(stringifyPretty(.obj(broad.map { ($0.label, taxonomyEntries($0.values)) })))
        } else {
            print(formatTaxonomy(broad))
        }
    }
}

/// `ad-cli browse <framework> --db <PATH> [--path <P>] [--limit <N>] [--year <Y>]
/// [--json]` — explore a documentation root. Resolves the root (exact → fuzzy),
/// then produces one of three shapes: a page's children (`--path`), wwdc session
/// counts per year (wwdc default), or a page listing (default / wwdc+year/limit).
struct BrowseCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "browse", abstract: "Explore a documentation root's pages and children.")

    @Argument(help: "The framework/root slug or name to browse.")
    var framework: String

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Browse the children of a specific page path.")
    var path: String?

    @Option(name: .long, help: "Cap the number of listed pages.")
    var limit: Int?

    @Option(name: .long, help: "Filter the wwdc root to one year.")
    var year: Int?

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        let connection = openCorpus(corpus.db)

        guard let root = connection.resolveRoot(framework) else {
            failBrowse("Unknown framework: \(framework)")
        }
        let isWwdc = root.sourceType == "wwdc"
        if year != nil && !isWwdc {
            failBrowse("year only applies to the wwdc root")
        }

        // --path: a page's children, grouped by section.
        if let path {
            guard let page = connection.browsePage(path) else {
                failBrowse("Page not found: \(path)")
            }
            let refs = connection.documentChildren(page.path)
            let children = refs.map { BrowseChildEntry(path: $0.targetPath, title: $0.title, section: $0.section) }
            emit(.children(framework: root.displayName, path: path, title: page.title, children: children))
            return
        }

        var allPages = connection.pagesByRoot(root.slug)

        if isWwdc, let year {
            // Keep only this year's sessions: `wwdc/wwdc<year>-` prefix.
            let prefix = "wwdc/wwdc\(year)-"
            allPages = allPages.filter { $0.path.hasPrefix(prefix) }
            if allPages.isEmpty {
                failBrowse("No WWDC sessions indexed for \(year)")
            }
        } else if isWwdc && limit == nil {
            // GROUPS variant: count sessions per year, sort year DESC.
            var order: [Int] = []
            var counts: [Int: Int] = [:]
            for page in allPages {
                guard let sessionYear = wwdcYear(of: page.path) else { continue }
                if counts[sessionYear] == nil { order.append(sessionYear) }
                counts[sessionYear, default: 0] += 1
            }
            let groups =
                order
                .sorted { $0 > $1 }
                .map { BrowseGroupEntry(year: $0, count: counts[$0] ?? 0) }
            emit(
                .groups(
                    framework: root.displayName, slug: root.slug, kind: root.kind, groups: groups, total: allPages.count
                ))
            return
        }

        // PAGES variant (default, or wwdc+year, or wwdc+limit). JS truthy-checks
        // `opts.limit`: 0 is falsy ⇒ no cap; any non-zero ⇒ max(n, 1).
        let effectiveLimit: Int? = (limit != nil && limit != 0) ? max(limit!, 1) : nil
        let pages = effectiveLimit.map { Array(allPages.prefix($0)) } ?? allPages
        let pageEntries = pages.map {
            BrowsePageEntry(path: $0.path, title: $0.title, kind: $0.roleHeading ?? $0.role, abstract: $0.abstract)
        }
        emit(
            .pages(
                framework: root.displayName, slug: root.slug, kind: root.kind, year: year, pages: pageEntries,
                total: allPages.count, limited: effectiveLimit.map { $0 < allPages.count } ?? false))
    }

    /// Print the result as JSON or the human listing.
    private func emit(_ result: BrowseResult) {
        if json {
            print(stringifyPretty(projectBrowse(result)))
        } else {
            print(formatBrowse(result))
        }
    }
}

/// `ad-cli read <target> --db <PATH> [--framework F] [--section S]
/// [--max-chars N] [--page P] [--json]` — document lookup. Ports cli.js's `read`
/// verb: resolve the page (path → document with a normalize retry, else symbol →
/// searchByTitle), render Markdown from the DB sections, optionally extract one
/// section / paginate the content, then print the human formatter or the
/// `projectReadDoc({full:true})` JSON. Mirrors ad-server read_doc's orchestration
/// (the parity-proven native read), plus the CLI-only pagination + formatter.
struct ReadCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "read", abstract: "Read a documentation page as Markdown, by path or symbol name.")

    @Argument(help: "The page path (contains '/') or symbol name to read.")
    var target: String

    @OptionGroup var corpus: CorpusOptions

    @Option(name: .long, help: "Disambiguate a symbol target by framework slug.")
    var framework: String?

    @Option(name: .long, help: "Extract a single section by heading or kind.")
    var section: String?

    @Option(name: .long, help: "Paginate the content to at most N chars per page (floor 200).")
    var maxChars: Int?

    @Option(name: .long, help: "1-based page number (needs --max-chars).")
    var page: Int?

    @Flag(name: .long, help: "Emit JSON instead of the human listing.")
    var json = false

    func run() throws {
        let connection = openCorpus(corpus.db)

        // cli.js: a '/'-bearing target is a path; otherwise a symbol (with the
        // optional --framework disambiguator). --section widens the lookup.
        let opts: LookupOptions =
            target.contains("/")
            ? LookupOptions(path: target, symbol: nil, framework: nil, section: section)
            : LookupOptions(path: nil, symbol: target, framework: framework, section: section)

        // cli.js `dataDir` = `--home` = the directory holding apple-docs.db (and
        // the markdown/ + raw-json content trees); the native verb derives it
        // from `--db`, exactly as `status` does.
        var result = lookup(opts, connection, dataDir: (corpus.db as NSString).deletingLastPathComponent)
        // Paginate only when --max-chars is given AND content rendered (JS:
        // `maxChars != null && result.found && result.content`).
        if let maxChars, result.found, let content = result.content {
            result = paginateCliContent(result, content: content, maxChars: maxChars, pageNum: page ?? 1)
        }

        if json {
            print(stringifyPretty(projectReadDoc(result)))
        } else {
            print(formatLookup(result))
        }
    }
}

/// The 4-digit year of a WWDC session path: matches `wwdc/wwdc` + exactly four
/// digits + `-` and returns those digits. Mirrors JS `/^wwdc\/wwdc(\d{4})-/`.
func wwdcYear(of path: String) -> Int? {
    let prefix = "wwdc/wwdc"
    guard path.hasPrefix(prefix) else { return nil }
    let digits = path.dropFirst(prefix.count)
    var scanned = ""
    for character in digits {
        guard character.isASCIIDigit else {
            break
        }
        scanned.append(character)
        if scanned.count > 4 { return nil }  // more than 4 leading digits ⇒ no match
    }
    guard scanned.count == 4 else { return nil }
    // The char right after the 4 digits must be '-'.
    let afterDigits = digits.dropFirst(4)
    guard afterDigits.first == "-" else { return nil }
    return Int(scanned)
}

extension Character {
    /// ASCII `0`–`9` (JS `\d` is ASCII-only here; session years are plain digits).
    fileprivate var isASCIIDigit: Bool { self >= "0" && self <= "9" }
}

// MARK: - taxonomy field plumbing

/// The Bun `kinds` verb calls taxonomy with no limit override ⇒ always 20.
let taxonomyDefaultLimit = 20

/// The broad-shape fields IN ORDER. `docKind` is the JS alias that runs the same
/// query as `kind` (the native enum has no docKind case).
private let broadTaxonomyFields = ["kind", "role", "docKind", "roleHeading", "sourceType"]

/// field name → storage column. Returns nil for an unknown field (caller falls
/// back to the broad shape, matching JS `field && queries[field]`).
func taxonomyColumn(for field: String) -> TaxonomyColumn? {
    switch field {
        case "kind": return .kind
        case "role": return .role
        case "docKind": return .kind  // alias: same query as kind
        case "roleHeading": return .roleHeading
        case "sourceType": return .sourceType
        default: return nil
    }
}

/// The five broad-shape sections, each top-20, in the pinned key order.
func broadTaxonomy(_ connection: StorageConnection) -> [TaxonomySection] {
    broadTaxonomyFields.map { field in
        // Every field maps to a known column; the force is total (the list is fixed).
        let column = taxonomyColumn(for: field) ?? .kind
        return TaxonomySection(
            label: field, values: connection.taxonomyCounts(column: column, limit: taxonomyDefaultLimit))
    }
}

// MARK: - JSON projections (allowlist + pinned key order)

/// frameworks → `{ "total": <int>, "roots": [ {slug,name,kind,pageCount}, ... ] }`.
func projectFrameworks(_ roots: [FrameworkRoot]) -> JSONValue {
    let rootValues: [JSONValue] = roots.map { root in
        .obj([
            ("slug", .string(root.slug)),
            ("name", .string(root.name)),
            ("kind", .string(root.kind)),
            ("pageCount", .int(root.pageCount))
        ])
    }
    return .obj([
        ("total", .int(Int64(roots.count))),
        ("roots", .array(rootValues))
    ])
}

/// `[ {"value":...,"count":...}, ... ]` for a taxonomy field.
func taxonomyEntries(_ values: [TaxonomyCount]) -> JSONValue {
    .array(values.map { .obj([("value", .string($0.value)), ("count", .int($0.count))]) })
}

/// browse → the allowlisted projection, per-variant, in the pinned key order of
/// JS `projectBrowse` (framework, title, path, year, groups+total, pages+total,
/// children). `pick` keeps JSON `null` values, so a nil `String?` emits `null`
/// rather than being omitted; a field the variant lacks is dropped entirely.
func projectBrowse(_ result: BrowseResult) -> JSONValue {
    switch result {
        case .children(let framework, let path, let title, let children):
            // Command children are `{path,title,section}`; pick(['path','title','kind','section'])
            // drops the absent `kind` and keeps null title/section.
            let childValues: [JSONValue] = children.map { child in
                .obj([
                    ("path", .string(child.path)),
                    ("title", jOptional(child.title)),
                    ("section", jOptional(child.section))
                ])
            }
            return .obj([
                ("framework", .string(framework)),
                ("title", jOptional(title)),
                ("path", .string(path)),
                ("children", .array(childValues))
            ])

        case .groups(let framework, _, _, let groups, let total):
            let groupValues: [JSONValue] = groups.map {
                .obj([("year", .int(Int64($0.year))), ("count", .int(Int64($0.count)))])
            }
            return .obj([
                ("framework", .string(framework)),
                ("groups", .array(groupValues)),
                ("total", .int(Int64(total)))
            ])

        case .pages(let framework, _, _, let year, let pages, let total, _):
            let pageValues: [JSONValue] = pages.map { page in
                .obj([
                    ("path", .string(page.path)),
                    ("title", jOptional(page.title)),
                    ("kind", jOptional(page.kind)),
                    ("abstract", jOptional(page.abstract))
                ])
            }
            var pairs: [(String, JSONValue)] = [("framework", .string(framework))]
            if let year { pairs.append(("year", .int(Int64(year)))) }
            pairs.append(("pages", .array(pageValues)))
            pairs.append(("total", .int(Int64(total))))
            return .obj(pairs)
    }
}

/// An optional string as JSON: a value → string, nil → `null` (pick keeps nulls).
private func jOptional(_ value: String?) -> JSONValue {
    value.map(JSONValue.string) ?? .null
}

/// JS `String.prototype.trim()` for `--field` (ASCII whitespace — field values are tokens).
private func trimWhitespace(_ string: String) -> String {
    var scalars = Array(string.unicodeScalars)
    while let first = scalars.first, isASCIIWhitespace(first) { scalars.removeFirst() }
    while let last = scalars.last, isASCIIWhitespace(last) { scalars.removeLast() }
    var result = ""
    result.unicodeScalars.append(contentsOf: scalars)
    return result
}
