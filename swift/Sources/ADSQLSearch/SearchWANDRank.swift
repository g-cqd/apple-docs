public import ADDBExec
public import ADSQLModel
import Synchronization

// WS-C — rank-only WAND restructure of the tiered §2.2 read.
//
// The score-all `denormSQL` (`… ORDER BY tier, rank LIMIT k`) CANNOT use ADDB's
// block-max WAND top-k (which requires a pure `ORDER BY rank ASC LIMIT k`): to sort
// by `(tier, rank)` it scores EVERY match (~50k for a broad term). This rewrite
// produces the byte-for-byte SAME top-k by routing the RANKING through single-table
// WAND and reconstructing the `(tier, rank)` order in a tight Swift post-pass.
//
// ## Why it is identical to score-all
// `tier` is a pure lexical pre-classification of the DOCUMENT (independent of rank):
//   0 = title_lc == raw_lc OR key_lc == raw_lc   (exact)
//   1 = title_lc has prefix raw_lc               (LIKE raw_lc||'%')
//   2 = title_lc contains raw_lc                 (INSTR > 0)
//   3 = otherwise
// The final order is `(tier ASC, rank ASC, rowid ASC)` — WAND's own tie-break is
// `(rank ASC, docid ASC)`, and the score-all path breaks `(tier, rank)` ties in FTS
// scan order (docid ASC), so the two agree exactly.
//
// The retrieval is a rank-only WAND top-K (K ≥ limit) plus the observation that the
// true top-`limit` by `(tier, rank)` is contained in the rank-only top-K whenever K
// is at least the worst rank-position among those `limit` rows. The tiers strictly
// below the cut hold FEWER than `limit` documents (else the cut would be lower), and
// are found EXACTLY via secondary indexes on `title_lc`/`key_lc` (no per-match scan),
// so membership in the fetched top-K is a cheap set test. Three runtime certificates
// prove completeness before returning; anything they cannot prove declines to the
// score-all oracle. See `SearchWANDRankParityTests` for the identity proof.
enum SearchWAND {
    /// True when any §2.4 filter is active. The rank-only WAND ignores the filter
    /// predicates, and applying them post-hoc would drop rows out of the top-k
    /// (yielding fewer than k, and missing the true k-th) — so a filtered request
    /// declines to the score-all path, which applies them correctly.
    /// Below this many fully-fetched matches, tiering every row (one by-id fetch) beats
    /// the per-tier index probes — so a small exhausted match set takes the exact-all
    /// route. Kept under the smallest "index-set wins" probe (urlsession ≈ 141) so that
    /// worstTier ≤ 1 sets large enough to prefer a 25-row fetch still use the index path.
    static let exactAllThreshold = 96

    static func hasActiveFilters(_ p: SearchPagesParams) -> Bool {
        if p.framework != nil || p.sourceType != nil || p.sourcesJSON != nil || p.kind != nil
            || p.language != nil || p.year != nil || p.trackLike != nil
            || p.minIOS != nil || p.minMacOS != nil || p.minWatchOS != nil
            || p.minTVOS != nil || p.minVisionOS != nil
        {
            return true
        }
        switch p.deprecatedMode {
            case nil, "include": return false
            default: return true
        }
    }

    /// `raw_lc` is WAND-eligible only when it is printable ASCII with no LIKE
    /// metacharacter: tier-1 is `title_lc LIKE raw_lc||'%'` and tier-2 is `INSTR`, and
    /// the index prefix-range + `hasPrefix`/`contains` fold reproduces those ONLY for
    /// a literal, byte-orderable term. Anything else declines to score-all.
    static func eligibleRaw(_ rawLc: String) -> Bool {
        guard !rawLc.isEmpty else { return false }
        for b in rawLc.utf8 where !(b >= 0x20 && b < 0x7F && b != 0x25 && b != 0x5F) {
            return false  // control / non-ASCII / '%' (0x25) / '_' (0x5F)
        }
        return true
    }

    // MARK: - one-time secondary indexes (memoized per Database)

    private static let built = Mutex<Set<ObjectIdentifier>>([])

    /// Builds the `documents(title_lc)` / `documents(key_lc)` indexes once per
    /// database (idempotent `IF NOT EXISTS`). These turn tier-0/1 candidate discovery
    /// into an index equality / prefix-range scan (tens of µs) instead of a full-corpus
    /// title scan. A committed index write does NOT touch the FTS trees, so the O(1)
    /// `FTSLengthCache` (keyed by the FTS roots) stays valid.
    static func ensureIndexes(_ db: Database) throws(DBError) {
        let key = ObjectIdentifier(db)
        if built.withLock({ $0.contains(key) }) { return }
        _ = try db.prepare("CREATE INDEX IF NOT EXISTS idx_doc_title_lc ON documents(title_lc)").all([:])
        _ = try db.prepare("CREATE INDEX IF NOT EXISTS idx_doc_key_lc ON documents(key_lc)").all([:])
        built.withLock { _ = $0.insert(key) }
    }

    // MARK: - rank-only WAND top-K (single-table ⇒ block-max WAND)

    /// The single-table rank-only top-K: `SELECT rowid, bm25 … ORDER BY rank LIMIT k`.
    /// `k` is inlined (an Int — no injection surface) so the plan is the literal-LIMIT
    /// shape the executor routes to WAND. Returns `(rowid, rank)` in `(rank ASC,
    /// rowid ASC)` order — WAND's exact output order.
    static func wandTopK(_ db: Database, query: String, k: Int) throws(DBError) -> [(id: Int64, rank: Double)] {
        let sql = """
            SELECT documents_fts.rowid AS id, bm25(documents_fts, 10.0, 5.0, 3.0, 2.0, 1.0) AS rank
            FROM documents_fts WHERE documents_fts MATCH $query ORDER BY rank LIMIT \(k)
            """
        return try db.prepare(sql).all(["query": .text(query)])
            .map { row in
                let d = row.decode()
                return (d.int("id") ?? -1, d.double("rank") ?? 0)
            }
    }

    /// The set of `documents.id` a scalar `id` query returns (tier-candidate discovery).
    static func idSet(_ db: Database, _ sql: String, _ binds: [String: Value]) throws(DBError) -> Set<Int64> {
        var out = Set<Int64>()
        for row in try db.prepare(sql).all(binds) {
            if let id = row.decode().int("id") { out.insert(id) }
        }
        return out
    }

    // MARK: - ordering

    /// Reorders WAND rows (already `(rank ASC, id ASC)`) into `(tier ASC, rank ASC,
    /// id ASC)` via a STABLE sort on tier alone — the (offset) tie-break preserves the
    /// incoming rank/id order (Swift's `sorted` is not itself stable).
    static func reorder(
        _ rows: [(id: Int64, rank: Double, tier: Int)]
    ) -> [(id: Int64, rank: Double, tier: Int)] {
        rows.enumerated()
            .sorted { a, b in
                if a.element.tier != b.element.tier { return a.element.tier < b.element.tier }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    /// The exact tier of a row from its precomputed `title_lc`/`key_lc` and `raw_lc` —
    /// the Swift image of the `denormProjection` tier `CASE` (raw_lc guaranteed
    /// non-empty and metacharacter-free by `eligibleRaw`).
    static func exactTier(titleLc: String, keyLc: String, rawLc: String) -> Int {
        if titleLc == rawLc || keyLc == rawLc { return 0 }
        if titleLc.hasPrefix(rawLc) { return 1 }
        if titleLc.contains(rawLc) { return 2 }
        return 3
    }

    /// The exclusive upper bound of the byte-wise prefix range for `s` (ASCII, last
    /// byte < 0x7E): `s` with its last byte incremented. nil when `s` is empty or ends
    /// at 0x7E — the caller then declines.
    static func prefixUpperBound(_ s: String) -> String? {
        var bytes = Array(s.utf8)
        guard let last = bytes.last, last < 0x7E else { return nil }
        bytes[bytes.count - 1] = last + 1
        return String(decoding: bytes, as: UTF8.self)
    }

    // MARK: - final projection fetch (by id)

    /// The `denormProjection`'s 22 output columns keyed by their RowDecoder aliases,
    /// plus `__id`/`__title_lc`/`__key_lc` for mapping + exact tiering — fetched by
    /// id (documents-only, indexed) for just the winning rows.
    static let byIdProjection = """
        d.key AS path, d.title, d.role, d.role_heading, d.abstract_text AS abstract,
        d.declaration_text AS declaration, d.platforms_json AS platforms,
        d.min_ios, d.min_macos, d.min_watchos, d.min_tvos, d.min_visionos,
        d.root_display AS framework, d.root_slug AS root_slug,
        d.source_type, d.source_metadata, d.url_depth, d.is_release_notes,
        d.is_deprecated, d.is_beta, d.kind AS doc_kind, d.language,
        d.id AS __id, d.title_lc AS __title_lc, d.key_lc AS __key_lc
        """

    /// Decodes the by-id projection for `ids` into `id → (row, title_lc, key_lc)`.
    static func fetchRows(
        _ db: Database, ids: [Int64]
    ) throws(DBError) -> [Int64: (row: SearchProjectionRow, titleLc: String, keyLc: String)] {
        guard !ids.isEmpty else { return [:] }
        let inList = ids.map(String.init).joined(separator: ",")
        let sql = "SELECT \(byIdProjection) FROM documents d WHERE d.id IN (\(inList))"
        var out: [Int64: (row: SearchProjectionRow, titleLc: String, keyLc: String)] = [:]
        out.reserveCapacity(ids.count)
        for row in try db.prepare(sql).all([:]) {
            let d = row.decode()
            guard let id = d.int("__id") else { continue }
            out[id] = (SearchProjectionRow(d), d.text("__title_lc") ?? "", d.text("__key_lc") ?? "")
        }
        return out
    }

    /// Materializes `ordered` (already the final `(tier, rank, id)` order) into rows:
    /// fetch by id, then stamp each row's `rank`/`tier` from the ordering.
    static func fetchFinal(
        _ db: Database, _ ordered: [(id: Int64, rank: Double, tier: Int)]
    ) throws(DBError) -> [SearchProjectionRow] {
        let rows = try fetchRows(db, ids: ordered.map(\.id))
        var out: [SearchProjectionRow] = []
        out.reserveCapacity(ordered.count)
        for entry in ordered {
            guard var row = rows[entry.id]?.row else { continue }
            row.rank = entry.rank
            row.tier = Int64(entry.tier)
            out.append(row)
        }
        return out
    }
}

extension Database {
    /// Runs the DENORMALIZED §2.2 search for `params` and returns the decoded §2.3
    /// projection rows — the structured form the cascade consumes. WS-C routes the
    /// RANKING through single-table block-max WAND and reconstructs the `(tier, rank)`
    /// top-k in Swift, producing rows IDENTICAL to
    /// ``searchPagesDenormRowsScoreAll(_:)`` (proven by `SearchWANDRankParityTests`)
    /// while avoiding the score-every-match cost of `… ORDER BY tier, rank`. Declines
    /// (falls back to score-all) for shapes it cannot prove identical.
    public func searchPagesDenormRows(_ params: SearchPagesParams) throws(DBError) -> [SearchProjectionRow] {
        if let rows = try wandTierRows(params) { return rows }
        return try searchPagesDenormRowsScoreAll(params)
    }

    /// The WAND restructure. Returns nil to DECLINE (caller uses the score-all oracle).
    func wandTierRows(_ params: SearchPagesParams) throws(DBError) -> [SearchProjectionRow]? {
        let limit = Int(params.limit)
        guard limit >= 1 else { return [] }
        guard !SearchWAND.hasActiveFilters(params) else { return nil }
        let rawLc = SearchDenorm.lower(params.raw)
        guard SearchWAND.eligibleRaw(rawLc) else { return nil }

        try SearchWAND.ensureIndexes(self)

        // tier-0 candidates: exact title_lc / key_lc (index equality).
        let t0 =
            try SearchWAND.idSet(self, "SELECT id FROM documents WHERE title_lc = $r", ["r": .text(rawLc)])
            .union(try SearchWAND.idSet(self, "SELECT id FROM documents WHERE key_lc = $r", ["r": .text(rawLc)]))

        var t1: Set<Int64>? = nil  // tier-1 prefix set; enumerated only when needed.
        var k = max(limit, 1024)
        let kMax = 1 << 18

        while true {
            let wand = try SearchWAND.wandTopK(self, query: params.query, k: k)
            let exhausted = wand.count < k  // the whole match set is in the top-K.

            // Small match set fully in hand: fetch every row and tier it EXACTLY in one
            // pass (correct for ANY worstTier), skipping the tier-0/1 index probes. This
            // is the cheapest route for a tiny corpus slice, where a per-tier index scan
            // would cost more than fetching the whole (small) set.
            if exhausted, wand.count <= SearchWAND.exactAllThreshold {
                return try exactReorderExhausted(wand: wand, rawLc: rawLc, limit: limit)
            }

            // Certificate B — worstTier == 0: is the top-`limit` entirely tier-0?
            let byT0 = wand.map { (id: $0.id, rank: $0.rank, tier: t0.contains($0.id) ? 0 : 1) }
            let c0 = SearchWAND.reorder(byT0).prefix(limit)
            if c0.count == limit, c0.last?.tier == 0 {
                // The `limit` tier-0 rows are the global top-`limit` tier-0 by rank
                // (every tier-0 with rank ≤ the boundary is in the top-K, and there are
                // ≥ limit of them) — independent of K. Provably identical.
                return try SearchWAND.fetchFinal(self, Array(c0))
            }

            // Need the tier-1 distinction. Enumerate the prefix set (index range) once.
            if t1 == nil {
                guard let hi = SearchWAND.prefixUpperBound(rawLc) else { return nil }
                t1 =
                    try SearchWAND.idSet(
                        self, "SELECT id FROM documents WHERE title_lc >= $lo AND title_lc < $hi",
                        ["lo": .text(rawLc), "hi": .text(hi)]
                    )
                    .subtracting(t0)
            }
            let t1set = t1 ?? []

            let classified = wand.map { entry -> (id: Int64, rank: Double, tier: Int) in
                let tier = t0.contains(entry.id) ? 0 : (t1set.contains(entry.id) ? 1 : 2)
                return (entry.id, entry.rank, tier)
            }
            let candidate = SearchWAND.reorder(classified).prefix(limit)
            let worst = candidate.last?.tier ?? 0

            if worst <= 1 {
                // Certificate A/C — worstTier ≤ 1: the cut is inside tiers {0,1}. Correct
                // iff every tier-0 doc is in the top-K (a missing one would displace);
                // the tier-1 winners are already the global best (the top-K holds every
                // doc with rank ≤ the boundary). `exhausted` ⇒ the match set IS the top-K.
                if exhausted || t0.isSubset(of: Set(wand.map(\.id))) {
                    return try SearchWAND.fetchFinal(self, Array(candidate))
                }
            } else if exhausted {
                // worstTier ≥ 2 with the whole (small) match set in hand: classify the
                // fetched rows EXACTLY (incl. the tier-2 substring) and reorder.
                return try exactReorderExhausted(wand: wand, rawLc: rawLc, limit: limit)
            } else {
                // worstTier ≥ 2 over a large match set: rare; decline to the oracle.
                return nil
            }

            // Tier-0 tail extends beyond the top-K: widen and retry, else decline.
            if k >= kMax { return nil }
            k = min(k * 8, kMax)
        }
    }

    /// The exhausted worstTier ≥ 2 branch: the entire match set is `wand`, so fetch every
    /// row, tier it EXACTLY (title_lc/key_lc), and reorder — the tier-2/3 split matters.
    private func exactReorderExhausted(
        wand: [(id: Int64, rank: Double)], rawLc: String, limit: Int
    ) throws(DBError) -> [SearchProjectionRow] {
        let rows = try SearchWAND.fetchRows(self, ids: wand.map(\.id))
        let classified = wand.compactMap { entry -> (id: Int64, rank: Double, tier: Int)? in
            guard let hit = rows[entry.id] else { return nil }
            return (entry.id, entry.rank, SearchWAND.exactTier(titleLc: hit.titleLc, keyLc: hit.keyLc, rawLc: rawLc))
        }
        let ordered = SearchWAND.reorder(classified).prefix(limit)
        var out: [SearchProjectionRow] = []
        out.reserveCapacity(ordered.count)
        for entry in ordered {
            guard var row = rows[entry.id]?.row else { continue }
            row.rank = entry.rank
            row.tier = Int64(entry.tier)
            out.append(row)
        }
        return out
    }
}
