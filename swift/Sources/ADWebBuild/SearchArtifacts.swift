// S3 — the `data/search/*` artifacts (src/web/search-artifacts.js): the
// columnar v2 title index, the alias map, the per-letter body shards, and the
// unhashed search-manifest. Pure: the corpus reads arrive via `SearchCorpus`
// (assembled by the ad-cli adapter from ADStorage); this module owns the
// byte-level `JSON.stringify` framing, the JS object key-enumeration order,
// the shard letter bucketing, and the `sha256(json).slice(0,10)` content
// hashes (ADBase.Sha256, byte-parity with Bun's CryptoHasher).

import ADBase

/// The columnar v2 title index (buildTitleIndex): parallel arrays in
/// `ORDER BY key`; `frameworks` is the sorted distinct set; `abstracts` are
/// pre-capped at 80 UTF-16 units.
public struct TitleIndexData: Sendable {
    public var frameworks: [String]
    public var keys: [String]
    public var titles: [String]
    public var abstracts: [String]
    public var fwIndices: [Int]
    public var kinds: [String]
    public var roleHeadings: [String]

    public init(
        frameworks: [String] = [], keys: [String] = [], titles: [String] = [],
        abstracts: [String] = [], fwIndices: [Int] = [], kinds: [String] = [],
        roleHeadings: [String] = []
    ) {
        self.frameworks = frameworks
        self.keys = keys
        self.titles = titles
        self.abstracts = abstracts
        self.fwIndices = fwIndices
        self.kinds = kinds
        self.roleHeadings = roleHeadings
    }
}

/// One document's body-shard input (buildBodyShards): the key, its framework
/// (shard letter), and the accumulated 500-UTF-16-unit body preview (already
/// trimmed; empty when the document has no section text).
public struct ShardDoc: Sendable {
    public let key: String
    public let framework: String?
    public let body: String
    public init(key: String, framework: String?, body: String) {
        self.key = key
        self.framework = framework
        self.body = body
    }
}

/// Everything `generateSearchArtifacts` reads from the corpus.
public struct SearchCorpus: Sendable {
    public var titleIndex: TitleIndexData
    /// `SELECT canonical, alias FROM framework_synonyms` in row order.
    public var aliases: [(alias: String, canonical: String)]
    /// Whether `document_sections` exists (selects the two buildBodyShards
    /// branches: entries per doc vs empty letter-touch shards).
    public var hasSections: Bool
    /// Documents in `ORDER BY id`, with accumulated body previews.
    public var shardDocs: [ShardDoc]

    public init(
        titleIndex: TitleIndexData = TitleIndexData(),
        aliases: [(alias: String, canonical: String)] = [],
        hasSections: Bool = true, shardDocs: [ShardDoc] = []
    ) {
        self.titleIndex = titleIndex
        self.aliases = aliases
        self.hasSections = hasSections
        self.shardDocs = shardDocs
    }
}

/// generateSearchArtifacts' return — fills `manifest.searchArtifacts`.
public struct SearchArtifactsStats: Sendable {
    public let titleCount: Int
    public let aliasCount: Int
    public let shardCount: Int
    public init(titleCount: Int, aliasCount: Int, shardCount: Int) {
        self.titleCount = titleCount
        self.aliasCount = aliasCount
        self.shardCount = shardCount
    }
}

extension BuildSite {
    /// Port of `generateSearchArtifacts(db, outDir)` as a pure artifact plan.
    /// `generatedAt` is injected (`new Date().toISOString()` in the driver) so
    /// the planner stays deterministic. Artifact order: title-index, aliases,
    /// shards (letter first-appearance order), then the manifest.
    public static func planSearchArtifacts(
        corpus: SearchCorpus, generatedAt: String
    ) -> (artifacts: [Artifact], stats: SearchArtifactsStats) {
        var artifacts: [Artifact] = []

        // title-index.<hash>.json — `{v:2, …}` in literal insertion order.
        let ti = corpus.titleIndex
        let titleJson =
            JsonLd.object([
                ("v", .int(2)),
                ("frameworks", .array(ti.frameworks.map(JsonLd.string))),
                ("keys", .array(ti.keys.map(JsonLd.string))),
                ("titles", .array(ti.titles.map(JsonLd.string))),
                ("abstracts", .array(ti.abstracts.map(JsonLd.string))),
                ("fwIndices", .array(ti.fwIndices.map(JsonLd.int))),
                ("kinds", .array(ti.kinds.map(JsonLd.string))),
                ("roleHeadings", .array(ti.roleHeadings.map(JsonLd.string)))
            ])
            .serialized()
        let titleHash = contentHash(titleJson)
        artifacts.append(Artifact(path: "data/search/title-index.\(titleHash).json", text: titleJson))

        // aliases.<hash>.json — `{alias: canonical}` built by insertion
        // (`aliasMap[alias] = canonical`), serialized in JS own-key order.
        let aliasPairs = jsObjectPairs(corpus.aliases.map { ($0.alias, $0.canonical) })
        let aliasJson = JsonLd.object(aliasPairs.map { ($0.0, .string($0.1)) }).serialized()
        let aliasHash = contentHash(aliasJson)
        artifacts.append(Artifact(path: "data/search/aliases.\(aliasHash).json", text: aliasJson))

        // shards/<letter>.<hash>.json — buildBodyShards. With sections, only
        // docs with a non-empty body create (and populate) their letter shard;
        // without sections, every doc's letter is touched but stays empty.
        var shardOrder: [String] = []
        var shards: [String: [(String, String)]] = [:]
        func ensureShard(_ letter: String) {
            if shards[letter] == nil {
                shards[letter] = []
                shardOrder.append(letter)
            }
        }
        for doc in corpus.shardDocs {
            if corpus.hasSections {
                if doc.body.isEmpty { continue }
                let letter = shardLetter(doc.framework)
                ensureShard(letter)
                shards[letter]?.append((doc.key, doc.body))
            } else {
                ensureShard(shardLetter(doc.framework))
            }
        }
        var shardMeta: [(letter: String, hash: String)] = []
        for letter in shardOrder {
            let pairs = jsObjectPairs(shards[letter] ?? [])
            let json = JsonLd.object(pairs.map { ($0.0, .string($0.1)) }).serialized()
            let hash = contentHash(json)
            shardMeta.append((letter: letter, hash: hash))
            artifacts.append(Artifact(path: "data/search/shards/\(letter).\(hash).json", text: json))
        }

        // search-manifest.json (NOT hashed — served no-cache).
        var files: [(String, JsonLd)] = [
            ("title-index", .string("title-index.\(titleHash).json")),
            ("aliases", .string("aliases.\(aliasHash).json"))
        ]
        for meta in shardMeta {
            files.append(("shard-\(meta.letter)", .string("shards/\(meta.letter).\(meta.hash).json")))
        }
        let stats = SearchArtifactsStats(
            titleCount: ti.keys.count, aliasCount: aliasPairs.count, shardCount: shardMeta.count)
        // `files` keys ("title-index" / "aliases" / "shard-<letter>") are never
        // array-index-like, so insertion order IS the JS enumeration order.
        let manifest =
            JsonLd.object([
                ("version", .int(2)),
                ("titleCount", .int(stats.titleCount)),
                ("aliasCount", .int(stats.aliasCount)),
                ("shardCount", .int(stats.shardCount)),
                ("files", .object(files)),
                ("generatedAt", .string(generatedAt))
            ])
            .serialized()
        artifacts.append(Artifact(path: "data/search/search-manifest.json", text: manifest))

        return (artifacts: artifacts, stats: stats)
    }

    /// `sha256(json).slice(0, 10)` (contentHash).
    static func contentHash(_ json: String) -> String {
        String(Sha256.hexString(json).prefix(10))
    }

    /// buildBodyShards' `letterFor`: the framework's FIRST UTF-16 unit,
    /// `.toLowerCase()`, then `[^a-z]` → `_`; `_` for a null/empty framework.
    /// ASCII fast path: a-z keep, A-Z lowercase, anything else `_` (full-Unicode
    /// toLowerCase corner cases like U+212A KELVIN → "k" are not reproduced;
    /// framework slugs are ASCII).
    static func shardLetter(_ framework: String?) -> String {
        guard let framework, let first = framework.utf16.first else { return "_" }
        switch first {
            case 0x61 ... 0x7A:  // a-z
                return String(UnicodeScalar(UInt8(first)))
            case 0x41 ... 0x5A:  // A-Z → lowercase
                return String(UnicodeScalar(UInt8(first + 32)))
            default:
                return "_"
        }
    }

    /// JS own-property enumeration order for a string-keyed object built by
    /// insertion (what `JSON.stringify` serializes): canonical array-index keys
    /// (`"0"`…`"4294967294"`, no leading zeros) ascending FIRST, then the rest
    /// in first-insertion order. A duplicate key keeps its FIRST position with
    /// its LAST value.
    static func jsObjectPairs(_ pairs: [(String, String)]) -> [(String, String)] {
        var order: [String] = []
        var values: [String: String] = [:]
        for (key, value) in pairs {
            if values[key] == nil { order.append(key) }
            values[key] = value
        }
        var integerKeys: [(UInt32, String)] = []
        var stringKeys: [String] = []
        for key in order {
            if let index = arrayIndexKey(key) {
                integerKeys.append((index, key))
            } else {
                stringKeys.append(key)
            }
        }
        integerKeys.sort { $0.0 < $1.0 }
        var out: [(String, String)] = []
        out.reserveCapacity(order.count)
        for (_, key) in integerKeys { out.append((key, values[key] ?? "")) }
        for key in stringKeys { out.append((key, values[key] ?? "")) }
        return out
    }

    /// A canonical ECMAScript array index: digits only, no leading zero (except
    /// `"0"`), value < 2³²−1.
    private static func arrayIndexKey(_ key: String) -> UInt32? {
        guard !key.isEmpty, key.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) else { return nil }
        if key.count > 1 && key.hasPrefix("0") { return nil }
        guard let value = UInt32(key), value < UInt32.max else { return nil }
        return value
    }
}
