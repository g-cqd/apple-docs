// Native semantic candidate retrieval (Stage 1) — the bit-exact port of
// `semanticCandidates` (chunk path) in the JS reference
// (apple-docs src/search/semantic.js). Lexical fusion + cascade integration are
// later stages; this delivers ONLY the semantic candidate list.
//
// Pipeline (chunk path), step-for-step with the JS:
//   1. qFp32 = embedder.embed(query)               (potion ignores isQuery)
//   2. qBin  = signCode(qFp32)                      (ADEmbed.Quantize)
//   3. load document_chunks ORDER BY document_id, ord → parallel arrays in row
//      order; keep rows where vec_bin.count == binWidth (64)
//   4. shortlistN = clamp(env APPLE_DOCS_SEMANTIC_SHORTLIST, 200, 16, 5000)
//   5. shortlist = shortlistByHamming(qBin, binPacked, 64, n, shortlistN)
//   6. rescore (default on): batch vec_i8 for the shortlist; per hit
//      score = 1 - dist/(64*8), then if vec_i8 present & 516 bytes,
//      score = dotI8(qFp32, vec_i8, 0, 512)
//   7. max-pool to documents in shortlist (dist,idx) order; keep STRICTLY
//      greater score (first-seen wins ties)
//   8. emit in docBest INSERTION order, STABLE-sort by score DESC (carry an
//      insertion index, tie-break on it — Swift's sort isn't stable), take topK
//
// Deps: ADStorage (chunk reads), ADEmbed (Embedder + Quantize.signCode), ADFCore
// (Popcount + Endian, transitively via ShortlistByHamming / DotI8).

#if canImport(Darwin)
    import Darwin
#else
    import Glibc
#endif

public import ADEmbed
public import ADStorage

/// One semantic candidate document. `distance` is the matched chunk's integer
/// Hamming distance; `score` is the rescored similarity (or the binary
/// `1 - dist/512` when no int8 code is present). `vec` is the matched chunk's
/// binary code (the JS `store.binPacked.subarray(...)`) — the doc's vector for
/// the Stage-2 MMR diversity pass. Stage 1's probe ignores `vec`; the cascade
/// fusion reads it.
public struct SemanticCandidate: Sendable {
    public let documentId: Int
    public let distance: Int
    public let score: Double
    public let vec: [UInt8]

    public init(documentId: Int, distance: Int, score: Double, vec: [UInt8] = []) {
        self.documentId = documentId
        self.distance = distance
        self.score = score
        self.vec = vec
    }
}

public enum Semantic {
    /// Top-K nearest documents to `query` over the chunk store. Returns `[]` when
    /// the chunk store is empty, the query can't be embedded, or the query width
    /// doesn't match the snapshot width (the JS degrade-to-lexical paths).
    public static func candidates(
        _ conn: StorageConnection, embedder: Embedder, query: String, topK: Int = 50
    ) -> [SemanticCandidate] {
        // Availability gate (cheap): chunk path requires a populated table.
        guard conn.getChunkCount() > 0 else { return [] }

        // Step 1: embed the query (potion ignores isQuery → native == JS). A
        // failed embed degrades to no semantic candidates.
        guard let qFp32 = try? embedder.embed(query) else { return [] }

        // Width guard: a query embedded at a different width than the snapshot
        // can't be compared (JS `qFp32.length !== store.dims → []`).
        let dims = conn.getEmbedDims(fallback: qFp32.count)
        guard qFp32.count == dims else { return [] }
        let binWidth = (dims + 7) / 8

        // Step 2: sign-quantize the query (bit i set iff qFp32[i] >= 0).
        let qBin = Quantize.signCode(qFp32)

        // Step 3: load the chunk store in row order, keeping width-matched codes.
        // Parallel arrays — index i is the load-bearing tie-break / lookup key.
        let rows = conn.getAllChunkVectors()
        guard !rows.isEmpty else { return [] }
        var binPacked = [UInt8]()
        binPacked.reserveCapacity(rows.count * binWidth)
        var chunkDocId = [Int]()
        chunkDocId.reserveCapacity(rows.count)
        var chunkId = [Int]()
        chunkId.reserveCapacity(rows.count)
        for row in rows where row.vecBin.count == binWidth {
            binPacked.append(contentsOf: row.vecBin)
            chunkDocId.append(row.documentId)
            chunkId.append(row.chunkId)
        }
        let n = chunkDocId.count
        guard n > 0 else { return [] }
        let bits = binWidth * 8

        // Step 4: shortlist size from the env clamp.
        let shortlistN = clampInt(envValue("APPLE_DOCS_SEMANTIC_SHORTLIST"), fallback: 200, min: 16, max: 5000)

        // Step 5: the K smallest Hamming distances, ascending by (dist, idx).
        let shortlist = ShortlistByHamming.select(
            qBin: qBin, binPacked: binPacked, width: binWidth, n: n, K: shortlistN)

        // Step 6: int8 rescore (default on; APPLE_DOCS_RESCORE=off disables).
        let rescore = !envEquals("APPLE_DOCS_RESCORE", "off")
        let i8Map: [Int: [UInt8]] = rescore ? conn.getChunkI8Batch(shortlist.map { chunkId[$0.idx] }) : [:]

        // Step 7: max-pool chunk scores up to their documents, in shortlist
        // (dist, idx) order; keep each doc's STRICTLY greater score (first-seen
        // wins ties). `docBest` records the insertion order via `order`, plus the
        // matched chunk row index (`matchedIdx`) so the doc's binary code can be
        // sliced out for the downstream MMR pass (JS keeps `idx` here for `vec`).
        struct DocBest { let score: Double; let distance: Int; let insertion: Int; let matchedIdx: Int }
        var docBest: [Int: DocBest] = [:]
        var order: [Int] = []
        for hit in shortlist {
            var score = 1.0 - Double(hit.dist) / Double(bits)
            if rescore, let i8 = i8Map[chunkId[hit.idx]], i8.count == dims + 4 {
                score = DotI8.dot(qFp32, i8, off: 0, dims: dims)
            }
            let docId = chunkDocId[hit.idx]
            if let prev = docBest[docId] {
                if score > prev.score {
                    docBest[docId] = DocBest(
                        score: score, distance: hit.dist, insertion: prev.insertion, matchedIdx: hit.idx)
                }
            } else {
                docBest[docId] = DocBest(
                    score: score, distance: hit.dist, insertion: order.count, matchedIdx: hit.idx)
                order.append(docId)
            }
        }

        // Step 8: emit in insertion order, then STABLE-sort by score DESC
        // (tie-break on insertion index, since Swift's sort isn't stable). Take topK.
        // The matched chunk's binary code rides along as `vec` (JS
        // `store.binPacked.subarray(idx*binWidth, idx*binWidth+binWidth)`).
        var out = order.map { docId -> (candidate: SemanticCandidate, insertion: Int) in
            let best = docBest[docId]!
            let base = best.matchedIdx * binWidth
            let vec = Array(binPacked[base ..< base + binWidth])
            return (
                SemanticCandidate(
                    documentId: docId, distance: best.distance, score: best.score, vec: vec),
                best.insertion)
        }
        out.sort { lhs, rhs in
            lhs.candidate.score != rhs.candidate.score
                ? lhs.candidate.score > rhs.candidate.score
                : lhs.insertion < rhs.insertion
        }
        if out.count > topK { out.removeLast(out.count - topK) }
        return out.map { $0.candidate }
    }
}

// MARK: - env helpers (Foundation-free; mirror the JS process.env reads)

/// The raw value of an env var, or nil when unset. `getenv` returns a C string
/// owned by the environment; copied into a Swift String here.
private func envValue(_ name: String) -> String? {
    guard let raw = getenv(name) else { return nil }
    return String(cString: raw)
}

/// Whether an env var equals `expected` (exact, case-sensitive — matches the JS
/// `process.env.X !== 'off'` comparison, which is exact).
private func envEquals(_ name: String, _ expected: String) -> Bool {
    envValue(name) == expected
}

/// `Math.min(max, Math.max(min, Number.parseInt(value, 10)))` with the JS
/// parseInt semantics: skip leading ASCII whitespace, an optional sign, then the
/// leading run of decimal digits; no digits ⇒ NaN ⇒ `fallback`. Trailing
/// non-digits are ignored (JS `parseInt('200x') === 200`).
private func clampInt(_ value: String?, fallback: Int, min minValue: Int, max maxValue: Int) -> Int {
    guard let parsed = parseIntPrefix(value) else { return fallback }
    return Swift.min(maxValue, Swift.max(minValue, parsed))
}

/// JS `Number.parseInt(_, 10)` prefix parse; nil for NaN (no leading digits).
private func parseIntPrefix(_ value: String?) -> Int? {
    guard let value else { return nil }
    var scalars = Array(value.unicodeScalars)[...]
    // Leading whitespace (ASCII space/tab/newline/CR/FF/VT — the JS StrWhiteSpace subset that matters here).
    while let first = scalars.first, first == " " || first == "\t" || first == "\n" || first == "\r"
        || first == "\u{0B}" || first == "\u{0C}"
    {
        scalars = scalars.dropFirst()
    }
    var negative = false
    if let first = scalars.first, first == "+" || first == "-" {
        negative = first == "-"
        scalars = scalars.dropFirst()
    }
    var magnitude = 0
    var sawDigit = false
    for scalar in scalars {
        guard scalar.value >= 0x30, scalar.value <= 0x39 else { break }
        sawDigit = true
        magnitude = magnitude * 10 + Int(scalar.value - 0x30)
    }
    guard sawDigit else { return nil }
    return negative ? -magnitude : magnitude
}
