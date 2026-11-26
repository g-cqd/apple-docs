import AemiJSONCore
import AppleDocsCore
import AppleDocsStorage
import Foundation

/// The accumulating result list of one search plus the per-framework tier runners (Bun `buildCascadeRunners`).
struct SearchState {
    let query: String
    let ftsQuery: String
    let frameworks: [String?]
    let filter: SearchSQLFilter
    let filters: SearchFilters
    let connection: SQLiteConnection
    let hasBody: Bool
    let searchLimit: Int
    /// The caller narrowed the scope (framework, kind, or a single source).
    let narrowed: Bool
    private(set) var results: [SearchResultItem] = []
    private var seen: Set<String> = []

    init(options: SearchOptions, query: String, on connection: SQLiteConnection) throws(SQLiteError) {
        self.query = query
        self.connection = connection
        self.ftsQuery = FTSQueryBuilder.buildLexicalQuery(query)
        var framework = options.framework
        if let requested = framework {
            framework = try CorpusRootResolver.resolve(requested, on: connection)?.slug ?? requested
        }
        var frameworks: [String?] = [framework]
        if let framework {
            for synonym in SearchRepository.frameworkSynonyms(framework, on: connection)
            where !frameworks.contains(synonym) {
                frameworks.append(synonym)
            }
        }
        self.frameworks = frameworks
        let sources = Self.sourceFilter(options.source)
        var minimums = options.minimumVersions
        if let platform = options.platform?.lowercased(), SearchFilters.platformKeys.contains(platform),
            (minimums[platform] ?? "").isEmpty
        {
            minimums[platform] = "0"
        }
        let deprecated = Self.deprecatedMode(options.deprecated)
        let window = options.limit + options.offset
        let postFiltered = options.kind != nil || minimums.values.contains { !$0.isEmpty }
        self.searchLimit = postFiltered ? min(max(window * 3, 60), 300) : window
        self.filter = SearchSQLFilter(
            framework: nil,
            sourceType: sources?.count == 1 ? sources?.first : nil,
            sources: sources.map { Array($0).sorted() },
            language: options.language,
            year: options.year,
            track: options.track,
            deprecatedMode: deprecated,
            limit: searchLimit
        )
        self.filters = SearchFilters(
            frameworks: frameworks,
            sourceTypes: sources,
            kind: options.kind,
            language: options.language,
            platformMinimums: minimums,
            year: options.year,
            track: options.track,
            deprecated: deprecated
        )
        self.hasBody = !options.noDeep && SearchRepository.hasBodyIndex(on: connection)
        self.narrowed = framework != nil || options.kind != nil || sources?.count == 1
    }

    /// Appends records that pass the filters and are new, in order.
    mutating func add(_ records: [SearchRecord], quality: (SearchRecord) -> String, distance: Int? = nil) {
        for record in records {
            let platforms = record.platforms.flatMap { try? AemiJSON.parse(Array($0.utf8)).root }
            guard filters.matches(record, platforms: platforms), seen.insert(record.path).inserted else { continue }
            results.append(SearchResultItem(record: record, matchQuality: quality(record), distance: distance))
        }
    }

    mutating func add(_ records: [SearchRecord], quality: String) {
        add(records, quality: { _ in quality })
    }

    // MARK: Tiers

    func perFramework(_ run: (SearchSQLFilter) throws(SQLiteError) -> [SearchRecord]) throws(SQLiteError)
        -> [SearchRecord]
    {
        var out: [SearchRecord] = []
        for framework in frameworks { out += try run(filter.scoped(to: framework)) }
        return out
    }

    mutating func runLexicalTiers(fast: Bool, requestedWindow: Int) {
        let exact =
            (try? perFramework { filter throws(SQLiteError) in
                try SearchRepository.searchTitleExact(query, filter: filter, on: connection)
            }) ?? []
        add(exact, quality: "exact")
        var fts: [SearchRecord] = []
        var trigram: [SearchRecord] = []
        if fast {
            if results.count < requestedWindow {
                fts = runFTS()
                trigram =
                    fts.count >= requestedWindow || (narrowed && results.count + fts.count > 0) ? [] : runTrigram()
            }
        } else {
            fts = runFTS()
            trigram = runTrigram()
        }
        add(fts) { CorpusSearch.tierLabel($0.tier) }
        add(trigram, quality: "substring")
    }

    /// `runFts`: the built query, else the raw text as one prefix phrase when FTS5 rejects it.
    func runFTS(_ expression: String? = nil) -> [SearchRecord] {
        let match = expression ?? ftsQuery
        if let rows = try? perFramework({ filter throws(SQLiteError) in
            try SearchRepository.searchPages(match, raw: query, filter: filter, on: connection)
        }) {
            return rows
        }
        guard expression == nil else { return [] }
        let simple = "\"" + query.replacingScalars("\"", with: "") + "\"*"
        return
            (try? perFramework { filter throws(SQLiteError) in
                try SearchRepository.searchPages(simple, raw: query, filter: filter, on: connection)
            }) ?? []
    }

    func runTrigram(_ text: String? = nil) -> [SearchRecord] {
        let source = text ?? query
        guard source.utf16.count >= 3 else { return [] }
        let expression = FTSQueryBuilder.sanitizeTrigramQuery(source)
        return
            (try? perFramework { filter in SearchRepository.searchTrigram(expression, filter: filter, on: connection) })
            ?? []
    }

    func runBody() -> [SearchRecord] {
        guard hasBody else { return [] }
        return (try? perFramework { filter in SearchRepository.searchBody(ftsQuery, filter: filter, on: connection) })
            ?? []
    }

    mutating func runFuzzy() {
        let matches = FuzzyTitleMatcher.matches(query, limit: searchLimit, on: connection)
        guard !matches.isEmpty, let records = try? SearchRepository.records(ids: matches.map(\.id), on: connection)
        else {
            return
        }
        var byID: [Int64: SearchRecord] = [:]
        for record in records { if let id = record.id { byID[id] = record } }
        for match in matches {
            guard let record = byID[match.id] else { continue }
            add([record], quality: { _ in "fuzzy" }, distance: match.distance)
        }
    }

    // MARK: Filters

    static func sourceFilter(_ source: String?) -> Set<String>? {
        guard let source else { return nil }
        let values = source.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
            .filter { !$0.isEmpty }
        return values.isEmpty ? nil : Set(values)
    }

    static func deprecatedMode(_ value: String?) -> String {
        let mode = (value ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        return ["exclude", "only", "include"].contains(mode) ? mode : "include"
    }
}
