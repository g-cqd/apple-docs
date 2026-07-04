// Stage 2 of the native semantic tier: fuse the Stage-1 semantic candidates
// (ADSemantic) into the rule-reranked lexical results, in place. A byte-exact
// port of src/search/fuse-semantic.js — the same hybrid/RRF fusion (ADSearch
// `Fusion`), exact-block hoist, and MMR diversity pass (ADSearch `MMR`) the JS
// CLI runs with native compute ON (the parity oracle). When the cascade's
// `semantic` parameter is nil (server/MCP), this never runs — the lexical path
// is unchanged.
//
// FLOAT/ORDER PARITY:
//   - The JS reads `APPLE_DOCS_FUSION` (default 'hybrid'), `APPLE_DOCS_MMR`
//     (default on), and `APPLE_DOCS_MMR_LAMBDA` (default 0.7, clamped 0..1) with
//     `parseFloat` prefix semantics — replicated here.
//   - The fusion math is ADSearch's `Fusion`, which mirrors the native FFI the JS
//     oracle dispatches to, so the fused doubles are bit-identical.
//   - The path↔index interning reproduces `fusion-native.js` packFusion: ids are
//     interned first-seen across lists in order (lexical first), so list index ==
//     JS interned id.
//   - Every JS `.sort((a,b) => b.score - a.score)` is STABLE; Swift's sort isn't,
//     so the fused-score sort carries a fresh insertion index as a tie-break.

public import ADEmbed  // Embedder is exposed by the public SemanticContext
import ADFCore  // NumberParse — the shared JS-parseFloat-prefix env parser
import ADSearch  // Fusion / MMR — used by the internal SemanticFusion methods
import ADSemantic  // Semantic.candidates + SemanticCandidate (internal use)
import ADStorage  // StorageConnection — the internal SemanticFusion.fuse param

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

/// The semantic configuration the CLI threads into the cascade: the loaded
/// embedder + the top-K candidate count (50, the JS `SEMANTIC_TOP_K`). Carried
/// as an optional on `Cascade.search`/`assemble`; nil ⇒ the semantic step is
/// skipped (server/MCP behavior, unchanged).
public struct SemanticContext: @unchecked Sendable {
    public let embedder: Embedder
    public let topK: Int

    public init(embedder: Embedder, topK: Int = 50) {
        self.embedder = embedder
        self.topK = topK
    }
}

enum SemanticFusion {
    /// Port of `fuseSemanticResults(results, sem, …)`. Blends `results` (already
    /// rule-reranked, FULL order) with the semantic candidates `sem` in place:
    /// inject semantic-only docs, fuse scores, hoist a small exact block, then run
    /// the MMR diversity pass over the head window. `requestedWindow` = offset+limit.
    static func fuse(
        _ results: inout [ResultHit], sem: [SemanticCandidate], conn: StorageConnection,
        filters: ActiveFilters, seen: inout Set<String>, requestedWindow: Int
    ) {
        // Lexical order + the rule-reranker's scores, captured BEFORE injecting
        // semantic-only docs (the lexical fusion signal is ranking.js's order).
        let lexicalRanked = results.map(\.path)
        var lexicalScores: [String: Double] = [:]
        lexicalScores.reserveCapacity(results.count)
        for r in results { lexicalScores[r.path] = r.score }

        // getSearchRecordsByIds(sem.map(c => c.documentId)) → byId. One batched fetch.
        let byId = conn.searchRecordsByIds(sem.map { Int64($0.documentId) })

        var semanticRanked: [String] = []
        var semanticScores: [String: Double] = [:]
        var vecByPath: [String: [UInt8]] = [:]
        for c in sem {
            guard let rec = byId[Int64(c.documentId)] else { continue }
            // parseRowPlatforms is a no-op here (Filters.matches reads the raw
            // platforms string directly).
            if !Filters.matches(rec, filters) { continue }
            semanticRanked.append(rec.path)
            semanticScores[rec.path] = c.score
            if !c.vec.isEmpty { vecByPath[rec.path] = c.vec }
            if seen.insert(rec.path).inserted {
                var hit = ResultHit(rec, matchQuality: "semantic")
                hit.origIndex = results.count
                results.append(hit)
            }
        }

        // Fusion: hybrid (default) or rrf. ADSearch.Fusion works on interned
        // integer ids; `interned` maps path→index first-seen (lexical then new
        // semantic), exactly as fusion-native.js does.
        let useRRF = (envValue("APPLE_DOCS_FUSION") ?? "hybrid") == "rrf"
        let fused =
            useRRF
            ? rrf(lexicalRanked: lexicalRanked, semanticRanked: semanticRanked)
            : hybrid(
                lexicalRanked: lexicalRanked, lexicalScores: lexicalScores,
                semanticRanked: semanticRanked, semanticScores: semanticScores)

        for i in results.indices { results[i].score = fused[results[i].path] ?? 0 }
        stableSortByScoreDesc(&results)

        // Lexical-dominance hoist: a small exact block (1..5) is restored to the
        // head in lexical-rank order.
        let exactCount = results.lazy.filter { $0.matchQuality == "exact" }.count
        if exactCount > 0, exactCount <= 5 {
            var lexPos: [String: Int] = [:]
            for (i, path) in lexicalRanked.enumerated() where lexPos[path] == nil { lexPos[path] = i }
            var exactBlock = results.filter { $0.matchQuality == "exact" }
            let rest = results.filter { $0.matchQuality != "exact" }
            // `.sort` is stable in JS; carry the current index as the tie-break.
            stableSort(&exactBlock) { a, b in
                (lexPos[a.path] ?? Int.max) < (lexPos[b.path] ?? Int.max)
            }
            results = exactBlock + rest
        }

        // MMR diversity over the head window (default on). Paths without a
        // semantic vector carry redundancy 0 → never demoted.
        if envValue("APPLE_DOCS_MMR") != "off", !vecByPath.isEmpty {
            let lambda = clampLambda(envValue("APPLE_DOCS_MMR_LAMBDA"))
            let window = min(results.count, max(requestedWindow, 20))
            reorderHeadByMMR(&results, window: window, vecByPath: vecByPath, lambda: lambda)
        }
    }

    // MARK: - fusion (path↔index interning mirrors fusion-native.js packFusion)

    /// weightedRRF over the two ranked path lists. Ids interned first-seen
    /// (lexical, then any new semantic); returns path → fused score.
    private static func rrf(lexicalRanked: [String], semanticRanked: [String]) -> [String: Double] {
        var interned: [String: Int] = [:]
        var ids: [String] = []
        intern(lexicalRanked, &interned, &ids)
        intern(semanticRanked, &interned, &ids)
        let lists = [
            Fusion.List(ranked: indices(lexicalRanked, interned), weight: 1.0),
            Fusion.List(ranked: indices(semanticRanked, interned), weight: 0.6)
        ]
        let scores = Fusion.weightedRRF(lists, idCount: ids.count)
        return mapScores(ids, scores)
    }

    /// hybridFusion (beta 0.5) over the two lists, score-aware. Mirrors the JS
    /// `hybridFusion([{lexical, scores}, {semantic, scores}], {beta:0.5})`.
    private static func hybrid(
        lexicalRanked: [String], lexicalScores: [String: Double],
        semanticRanked: [String], semanticScores: [String: Double]
    ) -> [String: Double] {
        var interned: [String: Int] = [:]
        var ids: [String] = []
        intern(lexicalRanked, &interned, &ids)
        intern(semanticRanked, &interned, &ids)
        let lists = [
            Fusion.List(
                ranked: indices(lexicalRanked, interned), weight: 1.0,
                scores: lexicalRanked.map { lexicalScores[$0] ?? 0 }),
            Fusion.List(
                ranked: indices(semanticRanked, interned), weight: 0.6,
                scores: semanticRanked.map { semanticScores[$0] ?? 0 })
        ]
        let scores = Fusion.hybrid(lists, idCount: ids.count, beta: 0.5)
        return mapScores(ids, scores)
    }

    /// First-seen interning of a ranked list into the shared id table.
    private static func intern(_ ranked: [String], _ interned: inout [String: Int], _ ids: inout [String]) {
        for key in ranked where interned[key] == nil {
            interned[key] = ids.count
            ids.append(key)
        }
    }

    /// A ranked path list → its interned indices (every key is already interned).
    private static func indices(_ ranked: [String], _ interned: [String: Int]) -> [UInt32] {
        ranked.map { UInt32(interned[$0] ?? 0) }
    }

    /// `ids[i] → scores[i]` (the JS shim's result-map build).
    private static func mapScores(_ ids: [String], _ scores: [Double]) -> [String: Double] {
        var out: [String: Double] = [:]
        out.reserveCapacity(ids.count)
        for i in ids.indices { out[ids[i]] = scores[i] }
        return out
    }

    // MARK: - MMR head reorder

    /// Reorder `results[0..<window]` by `MMR.select`, mirroring the native MMR FFI
    /// path the JS oracle takes: pack the window's vectors (binWidth bytes each,
    /// absent ⇒ presence bit 0), uncapped limit, then apply the returned
    /// permutation. The tail (>= window) is untouched.
    private static func reorderHeadByMMR(
        _ results: inout [ResultHit], window: Int, vecByPath: [String: [UInt8]], lambda: Double
    ) {
        guard window > 0 else { return }
        // n <= 2 ⇒ MMR is identity (matches JS `mmrSelect` and `MMR.select`).
        if window <= 2 { return }

        let head = Array(results[0 ..< window])
        // dim = first present vector's length (JS packMmr: first non-null vec).
        var dim = 0
        for hit in head {
            if let v = vecByPath[hit.path] {
                dim = v.count
                break
            }
        }

        let bitmapBytes = (window + 7) >> 3
        var presence = [UInt8](repeating: 0, count: max(bitmapBytes, 1))
        var rows = [UInt8](repeating: 0, count: window * dim)
        for (i, hit) in head.enumerated() {
            guard let vec = vecByPath[hit.path] else { continue }
            presence[i >> 3] |= UInt8(1 << (i & 7))
            if dim > 0 { rows.replaceSubrange(i * dim ..< i * dim + dim, with: vec) }
        }

        let order = rows.withUnsafeBytes { rowsPtr in
            presence.withUnsafeBytes { presencePtr in
                MMR.select(
                    n: window, dim: dim, vectors: rowsPtr, presence: presencePtr, lambda: lambda,
                    limit: 0)
            }
        }
        // splice(0, window, ...reordered): replace the head with the permuted head.
        let reordered = order.map { head[Int($0)] }
        results.replaceSubrange(0 ..< window, with: reordered)
    }

    // MARK: - stable sorts (Swift's sort isn't stable; carry an insertion index)

    /// `results.sort((a, b) => b.score - a.score)` made stable: equal scores keep
    /// the prior relative order (the JS sort is stable). Float compare is exact
    /// `>` / `<` — matching the JS subtraction's sign (a strict-weak order).
    private static func stableSortByScoreDesc(_ results: inout [ResultHit]) {
        let indexed = Array(results.enumerated())
        let sorted = indexed.sorted { lhs, rhs in
            if lhs.element.score != rhs.element.score { return lhs.element.score > rhs.element.score }
            return lhs.offset < rhs.offset
        }
        results = sorted.map(\.element)
    }

    /// A stable sort over an arbitrary element, by carrying the incoming index as
    /// a tie-break (reproduces JS `Array.sort` stability for the exact-block hoist).
    private static func stableSort<T>(_ array: inout [T], by less: (T, T) -> Bool) {
        let indexed = Array(array.enumerated())
        let sorted = indexed.sorted { lhs, rhs in
            if less(lhs.element, rhs.element) { return true }
            if less(rhs.element, lhs.element) { return false }
            return lhs.offset < rhs.offset
        }
        array = sorted.map(\.element)
    }

    // MARK: - env reads (JS process.env semantics)

    /// `Number.parseFloat(env ?? '0.7')`, clamped to [0, 1]; a non-finite parse
    /// (no leading number) → 0.7. Mirrors fuse-semantic.js's lambda read.
    private static func clampLambda(_ value: String?) -> Double {
        guard let parsed = parseFloatPrefix(value), parsed.isFinite else { return 0.7 }
        return Swift.min(1, Swift.max(0, parsed))
    }
}

// MARK: - env helpers (Foundation-free; mirror the JS process.env reads)

/// The raw value of an env var, or nil when unset. `getenv` returns a C string
/// owned by the environment; copied into a Swift String here.
private func envValue(_ name: String) -> String? {
    guard let raw = getenv(name) else { return nil }
    return String(cString: raw)
}

/// JS `Number.parseFloat(value)` prefix parse via the shared `ADFCore.NumberParse`: skip leading
/// ASCII whitespace, an optional sign, then the longest leading numeric run (digits, one optional
/// `.`-fraction, an optional `e`/`E` exponent). nil when no number leads (`NaN`); trailing
/// non-numeric chars are ignored (JS `parseFloat('0.7x')`).
///
/// Intrinsic-parity: identical to the JS parser for the ASCII env-config values read here
/// (`APPLE_DOCS_MMR_LAMBDA` etc.). The over-long-literal path is correctly rounded by the shared
/// Clinger kernel rather than a second `Double(String)` pass; it sheds only the (irrelevant-here)
/// non-ASCII-digit handling the scalar loop carried.
private func parseFloatPrefix(_ value: String?) -> Double? {
    value.flatMap { NumberParse.doublePrefix(Array($0.utf8)) }
}
