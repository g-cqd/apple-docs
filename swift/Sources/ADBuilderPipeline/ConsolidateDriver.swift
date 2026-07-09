// ConsolidateDriver — the failed-crawl doctor's ASYNC half (the network-riding steps
// of src/commands/consolidate.js + src/commands/consolidate/retry-transient.js over
// the SYNC core in `ADWrite.Consolidate`). Orchestrates:
//
//   resume-or-analyze  →  step 3 (retry the re-resolved paths, checkpointed batches)
//                      →  step 3b (delayed retry of TRANSIENT failures, 2 rounds)
//                      →  genuine count  →  optional minify pass
//
// Fetches ride the SAME adapter/HTTP machinery the crawl uses: each failed row's
// adapter is resolved from its root's `source_type` (registry), so a wwdc row
// re-fetches through the wwdc adapter, a swift-evolution row through its own, etc.
// (The JS fetches everything through the apple-docc data URL — `fetchDocPage` — which
// only ever worked for catalog rows; adapter routing is the native crawl's machinery
// applied uniformly.) Persisting goes through `CrawlPipeline.persist` with the crawl's
// own hash recipe (content = SHA-256 of the stable-stringified page, raw = SHA-256 of
// the payload bytes) and validators, so a re-fetched page's rows are indistinguishable
// from crawl-persisted ones — and, like the native crawl, no raw-json/markdown files
// are written (the storage pivot keeps content in the DB).
//
// Concurrency shape: children ONLY fetch+normalize (pure/network); every `db` touch —
// the page-exists probe, root lookup, persist, seed, crawl-state updates, checkpoints —
// stays on this serial task (the CrawlDriver discipline; the single-writer connection
// never crosses a task boundary). Step 3 processes `concurrency`-sized batches with a
// checkpoint after each (the JS while/pool/setSyncCheckpoint loop); the transient sweep
// is one sliding window per round (the JS pool over the whole transient set).
//
// Stateful adapters (swift-book builds its chapter index in `discover`) would normalize
// degraded here — consolidate never runs discover. Not reachable in practice: failed
// rows needing re-fetch are catalog/wwdc/evolution-shaped (stateless adapters).

public import ADBuilder
public import ADStorage
public import ADWrite
import Crypto
import Foundation

public struct ConsolidateDriver: Sendable {
    /// The consolidate knobs. `dryRun`/`minify` are the CLI flags; `retryTransient`,
    /// `transientRounds` (JS 2), `transientDelayMillis` (JS 30_000) and `sleep` mirror
    /// the JS programmatic options (injectable so the gate runs offline/undelayed).
    /// `concurrency` is the JS `max(1, APPLE_DOCS_CONCURRENCY ?? 5)`.
    public struct Options: Sendable {
        public var dryRun: Bool
        public var minify: Bool
        public var retryTransient: Bool
        public var transientRounds: Int
        public var transientDelayMillis: Int
        public var concurrency: Int
        public var now: String
        public var pid: Int64
        public var log: (@Sendable (String) -> Void)?
        public var sleep: @Sendable (_ milliseconds: Int) async throws -> Void

        public init(
            dryRun: Bool = false, minify: Bool = false, retryTransient: Bool = true,
            transientRounds: Int = 2, transientDelayMillis: Int = 30_000, concurrency: Int = 5,
            now: String, pid: Int64, log: (@Sendable (String) -> Void)? = nil,
            sleep: @escaping @Sendable (_ milliseconds: Int) async throws -> Void = {
                try await Task.sleep(for: .milliseconds($0))
            }
        ) {
            self.dryRun = dryRun
            self.minify = minify
            self.retryTransient = retryTransient
            self.transientRounds = transientRounds
            self.transientDelayMillis = transientDelayMillis
            self.concurrency = concurrency
            self.now = now
            self.pid = pid
            self.log = log
            self.sleep = sleep
        }
    }

    /// The consolidate() result object (JS field-for-field; `bodyIndexed` and the two
    /// verify reports are CLI-unreachable in the JS — emitted as constants by the verb).
    public struct Result: Sendable, Equatable {
        public var analyzed = 0
        public var cleaned = 0
        public var crossAdapter = 0
        public var resolved = 0
        public var retried = 0
        public var retriedOk = 0
        public var transientRecovered = 0
        public var genuine = 0
        public var minified = 0
        public var minifySaved = 0
        /// Populated for the dry-run report only (the JS `dryRun ? resolvedPaths : undefined`).
        public var resolvedPaths: [Consolidate.ResolvedPath] = []
        public var dryRun = false
        public init() {}
    }

    /// retryTransientFailures' return shape (`{ recovered, rounds, remaining }`).
    public struct TransientOutcome: Sendable, Equatable {
        public var recovered: Int
        public var rounds: Int
        public var remaining: Int
    }

    private let registry: SourceRegistry
    public init(registry: SourceRegistry) { self.registry = registry }

    /// The whole consolidate flow. The activity row brackets the run (cleared in a
    /// defer — the JS finally).
    public func run(
        _ db: SQLiteWriteConnection, dataDir: String, context: SourceContext, options: Options
    ) async throws -> Result {
        try Consolidate.setActivity(db, action: "consolidate", now: options.now, pid: options.pid)
        defer { try? Consolidate.clearActivity(db) }

        var state = try resumeOrAnalyze(db, dataDir: dataDir, options: options)

        // Step 3: retry resolved paths (unless dry-run).
        if !options.dryRun && !state.resolvedPaths.isEmpty {
            try await retryResolved(db, context: context, state: &state, options: options)
            try Consolidate.clearCheckpoint(db)
        }

        // Step 3b: delayed retry of *transient* failures (5xx / 429 / timeout). Skips
        // instantly when there are none, so a clean crawl pays no delay.
        var transientRecovered = 0
        if !options.dryRun && options.retryTransient {
            transientRecovered = try await retryTransientFailures(db, context: context, options: options)
                .recovered
        }

        var result = Result()
        result.analyzed = state.analyzed
        result.cleaned = state.cleaned
        result.crossAdapter = state.crossAdapter
        result.resolved = state.resolved
        result.retried = state.retried
        result.retriedOk = state.retriedOk
        result.transientRecovered = transientRecovered
        result.genuine = try Consolidate.genuineFailedCount(db)
        result.dryRun = options.dryRun
        if options.dryRun { result.resolvedPaths = state.resolvedPaths }

        // Step 4: minify existing JSON files if requested.
        if options.minify && !options.dryRun {
            options.log?("Minifying JSON files...")
            let minify = Consolidate.minifyDir(dataDir + "/raw-json", log: options.log)
            result.minified = minify.count
            result.minifySaved = minify.saved
            options.log?("Minified \(minify.count) files, saved \(Consolidate.megabytes(minify.saved)) MB")
        }
        return result
    }

    // MARK: - resume-or-analyze

    /// The counters + resolution list threaded through the retry steps.
    private struct ResumeState {
        var analyzed: Int
        var cleaned: Int
        var crossAdapter: Int
        var resolved: Int
        var retried: Int
        var retriedOk: Int
        var resolvedPaths: [Consolidate.ResolvedPath]
        var nextIndex: Int
    }

    /// Resume from the retry checkpoint (non-dry runs) or run steps 1-2 fresh — the JS
    /// `if (retryCheckpoint) … else …`. A resumed run restores every stored counter
    /// (`crossAdapter` stays 0 — the JS checkpoint never carries it); a fresh analysis
    /// with resolutions persists the initial checkpoint (nextIndex 0) before retrying.
    private func resumeOrAnalyze(
        _ db: SQLiteWriteConnection, dataDir: String, options: Options
    ) throws -> ResumeState {
        if !options.dryRun, let checkpoint = Consolidate.readCheckpoint(db) {
            let remaining = checkpoint.resolvedPaths.count - checkpoint.nextIndex
            options.log?("Resuming \(remaining) resolved retries from checkpoint...")
            return ResumeState(
                analyzed: checkpoint.analyzed, cleaned: checkpoint.cleaned, crossAdapter: 0,
                resolved: checkpoint.resolved, retried: checkpoint.retried,
                retriedOk: checkpoint.retriedOk, resolvedPaths: checkpoint.resolvedPaths,
                nextIndex: checkpoint.nextIndex)
        }
        let analysis = try Consolidate.analyze(
            db, dataDir: dataDir, dryRun: options.dryRun, log: options.log)
        let state = ResumeState(
            analyzed: analysis.analyzed, cleaned: analysis.cleaned, crossAdapter: analysis.crossAdapter,
            resolved: analysis.resolved, retried: 0, retriedOk: 0,
            resolvedPaths: analysis.resolvedPaths, nextIndex: 0)
        if !options.dryRun && !state.resolvedPaths.isEmpty {
            try Consolidate.writeCheckpoint(db, checkpoint(from: state), now: options.now)
        }
        return state
    }

    private func checkpoint(from state: ResumeState) -> Consolidate.Checkpoint {
        Consolidate.Checkpoint(
            analyzed: state.analyzed, cleaned: state.cleaned, resolved: state.resolved,
            retried: state.retried, retriedOk: state.retriedOk, nextIndex: state.nextIndex,
            resolvedPaths: state.resolvedPaths)
    }
}

// Step 3 — retry the re-resolved paths. Split from the primary declaration to stay
// within the type-body-length gate (the CrawlPersist extension-split precedent).
extension ConsolidateDriver {
    // MARK: - step 3: retry resolved paths

    /// The JS `while (nextIndex < resolvedPaths.length)` loop: `concurrency`-sized
    /// batches, a checkpoint write after each, so an interrupted run resumes at the
    /// last completed batch.
    private func retryResolved(
        _ db: SQLiteWriteConnection, context: SourceContext, state: inout ResumeState, options: Options
    ) async throws {
        options.log?("Retrying \(state.resolvedPaths.count) resolved paths...")
        let width = Swift.max(1, options.concurrency)
        while state.nextIndex < state.resolvedPaths.count {
            let end = Swift.min(state.nextIndex + width, state.resolvedPaths.count)
            let batch = Array(state.resolvedPaths[state.nextIndex ..< end])
            try await retryBatch(db, context: context, batch: batch, state: &state, options: options)
            state.nextIndex = end
            try Consolidate.writeCheckpoint(db, checkpoint(from: state), now: options.now)
        }
    }

    /// One retry work item: the resolution entry plus its serially-resolved target
    /// root (nil = unregistered root — fetch anyway, persist nothing; the JS quirk)
    /// and the adapter its root's source_type maps to.
    private struct RetryItem {
        let entry: Consolidate.ResolvedPath
        let rootId: Int64?
        let rootSlug: String
        let adapter: any SourceAdapter
    }

    /// One batch: probe/lookup serially, fetch+normalize the survivors concurrently,
    /// persist + update crawl_state serially as each completes (the JS pooled worker).
    private func retryBatch(
        _ db: SQLiteWriteConnection, context: SourceContext, batch: [Consolidate.ResolvedPath],
        state: inout ResumeState, options: Options
    ) async throws {
        // Serial pre-pass — the pooled worker's leading `db.getPage(newPath)` probe:
        // an already-persisted target just drops the old row (no fetch).
        var work: [RetryItem] = []
        for entry in batch {
            if try Consolidate.pageExists(db, entry.newPath) {
                try Consolidate.deleteCrawlState(db, path: entry.oldPath)
                state.retried += 1
                state.retriedOk += 1
                continue
            }
            let rootSlug = CrawlDriver.slug(ofKey: entry.newPath)
            let root = try Consolidate.rootBySlug(db, rootSlug)
            work.append(
                RetryItem(
                    entry: entry, rootId: root?.id, rootSlug: rootSlug,
                    adapter: adapter(forSourceType: root?.sourceType)))
        }
        guard !work.isEmpty else { return }

        var retried = state.retried
        var retriedOk = state.retriedOk
        try await withThrowingTaskGroup(of: FetchOutcome.self) { group in
            for (index, item) in work.enumerated() {
                let (adapter, path) = (item.adapter, item.entry.newPath)
                group.addTask { await Self.fetchNormalize(adapter, index: index, path: path, context: context) }
            }
            while let outcome = try await group.next() {
                switch outcome {
                    case .fetched(let fetched):
                        let item = work[fetched.index]
                        try persistRetried(db, item: item, fetched: fetched, now: options.now)
                        try CrawlPersist.setCrawlState(
                            db, path: item.entry.newPath, status: "processed", rootSlug: item.entry.root,
                            depth: 0)
                        try Consolidate.deleteCrawlState(db, path: item.entry.oldPath)
                        retried += 1
                        retriedOk += 1
                    case .failed(let index, let error):
                        let item = work[index]
                        try CrawlPersist.setCrawlState(
                            db, path: item.entry.oldPath, status: "failed", rootSlug: item.entry.root,
                            depth: 0, error: error)
                        retried += 1
                        options.log?("Retry failed: \(item.entry.newPath)")
                }
            }
        }
        state.retried = retried
        state.retriedOk = retriedOk
    }

    /// Persist one re-fetched resolution through the crawl pipeline and seed its
    /// same-root references (the JS `if (rootEntry) { upsertPage … seedCrawlIfNew }`;
    /// an unregistered root persists nothing but the retry still counts as OK).
    private func persistRetried(
        _ db: SQLiteWriteConnection, item: RetryItem, fetched: Fetched, now: String
    ) throws {
        guard let rootId = item.rootId else { return }
        try CrawlPipeline.persist(
            fetched.page, into: db, rootId: rootId, path: item.entry.newPath,
            hashes: .init(content: fetched.contentHash, rawPayload: fetched.rawHash),
            etag: fetched.etag, lastModified: fetched.lastModified, now: now)
        for ref in fetched.refs where CrawlDriver.slug(ofKey: ref) == item.rootSlug {
            try CrawlPersist.seedCrawlIfNew(db, path: ref, rootSlug: item.rootSlug, depth: 0)
        }
    }
}

// Step 3b — the transient-failure sweep — plus the fetch plumbing both steps share.
extension ConsolidateDriver {
    // MARK: - step 3b: transient-failure retry (retry-transient.js)

    /// Delayed retry of *transient* crawl failures: up to `transientRounds` rounds,
    /// each re-probing the failed set (only rows whose stored error classifies as
    /// transient), backing off `transientDelayMillis * round`, then re-fetching through
    /// each row's own adapter and re-persisting through the crawl pipeline. A clean
    /// corpus pays no delay — the first probe returns empty and the sweep exits.
    public func retryTransientFailures(
        _ db: SQLiteWriteConnection, context: SourceContext, options: Options
    ) async throws -> TransientOutcome {
        var recovered = 0
        var roundsRun = 0
        for index in 0 ..< Swift.max(0, options.transientRounds) {
            let round = index + 1
            let transient = try Consolidate.transientFailures(db)
            if transient.isEmpty { break }
            roundsRun = round
            let delay = options.transientDelayMillis * round
            let seconds = Int((Double(delay) / 1000).rounded())
            options.log?(
                "Transient-failure retry \(round)/\(options.transientRounds): \(transient.count) page(s) "
                    + "after \(seconds)s backoff")
            try await options.sleep(delay)

            // Serial pre-pass: root lookup (a row whose root is gone is skipped — kept
            // failed, the JS `if (!root) return`).
            var work: [TransientItem] = []
            for row in transient {
                guard let root = try Consolidate.rootBySlug(db, row.rootSlug) else { continue }
                work.append(
                    TransientItem(row: row, rootId: root.id, adapter: adapter(forSourceType: root.sourceType)))
            }
            recovered += try await retryTransientWave(db, context: context, work: work, options: options)
        }
        if recovered > 0 { options.log?("Transient-failure retry recovered \(recovered) page(s)") }
        return TransientOutcome(
            recovered: recovered, rounds: roundsRun,
            remaining: try Consolidate.transientFailures(db).count)
    }

    private struct TransientItem {
        let row: Consolidate.FailedRow
        let rootId: Int64
        let adapter: any SourceAdapter
    }

    /// One round's sliding window (the JS `pool(transient, concurrency, …)`): keep up
    /// to `concurrency` fetches in flight, persist serially as each completes. Success
    /// re-marks the row `processed`; a still-failing fetch/persist re-marks it `failed`
    /// with the fresh error (which may now classify as permanent).
    private func retryTransientWave(
        _ db: SQLiteWriteConnection, context: SourceContext, work: [TransientItem], options: Options
    ) async throws -> Int {
        guard !work.isEmpty else { return 0 }
        var recovered = 0
        var next = 0
        try await withThrowingTaskGroup(of: FetchOutcome.self) { group in
            func spawn() {
                guard next < work.count else { return }
                let (index, item) = (next, work[next])
                next += 1
                let (adapter, path) = (item.adapter, item.row.path)
                group.addTask { await Self.fetchNormalize(adapter, index: index, path: path, context: context) }
            }
            for _ in 0 ..< Swift.min(Swift.max(1, options.concurrency), work.count) { spawn() }
            while let outcome = try await group.next() {
                switch outcome {
                    case .fetched(let fetched):
                        let item = work[fetched.index]
                        do {
                            try CrawlPipeline.persist(
                                fetched.page, into: db, rootId: item.rootId, path: item.row.path,
                                hashes: .init(content: fetched.contentHash, rawPayload: fetched.rawHash),
                                etag: fetched.etag, lastModified: fetched.lastModified, now: options.now)
                            try CrawlPersist.setCrawlState(
                                db, path: item.row.path, status: "processed", rootSlug: item.row.rootSlug,
                                depth: 0)
                            recovered += 1
                        } catch {
                            try CrawlPersist.setCrawlState(
                                db, path: item.row.path, status: "failed", rootSlug: item.row.rootSlug,
                                depth: 0, error: String(describing: error))
                        }
                    case .failed(let index, let error):
                        let item = work[index]
                        try CrawlPersist.setCrawlState(
                            db, path: item.row.path, status: "failed", rootSlug: item.row.rootSlug,
                            depth: 0, error: error)
                }
                spawn()
            }
        }
        return recovered
    }

    // MARK: - shared fetch plumbing

    /// The adapter a root's `source_type` maps to; NULL or an unregistered type falls
    /// back to apple-docc — the JS default (`fetchDocPage` fetched everything through
    /// the DocC data URL; `sourceType: root.source_type ?? 'apple-docc'`).
    private func adapter(forSourceType sourceType: String?) -> any SourceAdapter {
        (try? registry.adapter(for: sourceType ?? AppleDoccAdapter.type)) ?? AppleDoccAdapter()
    }

    /// One page fetched + normalized in a child task, with the crawl's hash recipe
    /// (CrawlDriver's `bfsFetch` shape). `index` correlates the outcome back to its
    /// serial-side work item.
    private struct Fetched: Sendable {
        let index: Int
        let page: NormalizedPage
        let refs: [String]
        let contentHash: String
        let rawHash: String
        let etag: String?
        let lastModified: String?
    }

    private enum FetchOutcome: Sendable {
        case fetched(Fetched)
        case failed(index: Int, error: String)
    }

    /// Fetch + normalize + extract-references one path (pure/network — no `db`), for
    /// concurrent execution in a task group. Any failure becomes `.failed` (non-fatal),
    /// carrying the native error string the crawl itself would have stored.
    private static func fetchNormalize(
        _ adapter: any SourceAdapter, index: Int, path: String, context: SourceContext
    ) async -> FetchOutcome {
        do {
            let result = try await adapter.fetch(path, context)
            let page = try adapter.normalize(result.key, result.payload)
            let refs = adapter.extractReferences(result.key, result.payload)
            return .fetched(
                Fetched(
                    index: index, page: page, refs: refs,
                    contentHash: sha256Hex(Array(page.stableStringified().utf8)),
                    rawHash: sha256Hex(rawBytes(result.payload)),
                    etag: result.etag, lastModified: result.lastModified))
        } catch {
            return .failed(index: index, error: String(describing: error))
        }
    }

    private static func rawBytes(_ payload: SourcePayload) -> [UInt8] {
        switch payload {
            case .html(let text), .markdown(let text): return Array(text.utf8)
            case .json(let bytes), .bytes(let bytes): return bytes
        }
    }

    private static func sha256Hex(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
    }
}
