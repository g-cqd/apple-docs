// ad-cli — the native read CLI. The first slice of the P7 native CLI: two read
// verbs (`frameworks`, `kinds`) that mirror the Bun `cli.js` output 1:1 (the Bun
// CLI stays the parity oracle). Opens the corpus read-only via ADStorage and
// prints either the human formatter (Format.swift) or `JSON.stringify`-identical
// JSON (Json.swift) when `--json` is passed. A separate target from ad-server
// because each needs its own `@main`.

import ADStorage
import ArgumentParser
import Foundation

@main
struct ADCLICommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "ad-cli",
        abstract: "Apple Docs native read CLI (mirrors the Bun cli.js read verbs).",
        subcommands: [FrameworksCommand.self, KindsCommand.self])
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
func projectFrameworks(_ roots: [FrameworkRoot]) -> J {
    let rootValues: [J] = roots.map { root in
        .obj([
            ("slug", .s(root.slug)),
            ("name", .s(root.name)),
            ("kind", .s(root.kind)),
            ("pageCount", .i(root.pageCount))
        ])
    }
    return .obj([
        ("total", .i(Int64(roots.count))),
        ("roots", .arr(rootValues))
    ])
}

/// `[ {"value":...,"count":...}, ... ]` for a taxonomy field.
func taxonomyEntries(_ values: [TaxonomyCount]) -> J {
    .arr(values.map { .obj([("value", .s($0.value)), ("count", .i($0.count))]) })
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
