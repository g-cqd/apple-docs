// `ad-cli resources prerender-symbols` — bulk-bake every catalog SF Symbol x weight x scale variant
// into a theme-neutral SVG, upserted into `sf_symbol_renders`. Ports the SCALE (not the mechanism) of
// src/resources/apple-symbols/{sync,prerender-engine}.js `prerenderSfSymbols`: JS spawns a `swift`
// worker-process pool (or an FFI batch call into the dylib) because JS itself isn't native; `ad-cli`
// IS native, so this drives `ADRender.SymbolPdf`/`SymbolPdfToSvg` directly, in-process, through a
// bounded Swift TaskGroup — mirroring `ADBuilderPipeline.CrawlDriver`'s "concurrent CPU-bound work,
// single-writer serial persist" shape rather than reinventing a JS-style worker pool or FFI batching.
// Concurrent in-process AppKit symbol rendering is proven crash-free + byte-identical by the
// D-0003-3 probe (rfcs/0003-swift-render-service/records.md, Probe A: 400 symbols concurrently) —
// the exact operation `ad_render_symbol_pdf_batch`'s `DispatchQueue.concurrentPerform` already
// exercises at scale for the JS FFI path.
//
// Variant matrix: 9 weights x 3 scales = 27 (SYMBOL_WEIGHTS/SYMBOL_SCALES,
// apple-symbols/cache-key.js), identical for both scopes (private SF Symbols are
// NSSymbolImageRep-backed and honour `NSImage.withSymbolConfiguration(_:)` exactly like public
// ones). 8,478 public + 1,640 private symbols x 27 => 273,186 renders once both scopes are fully
// synced, matching JS's own `sync --full` log exactly (rfcs/0007-p7-cli-static-binary.md §11.7).
//
// macOS-only (SymbolPdf/SymbolPdfToSvg need AppKit) — matches ResourcesSyncSymbols.swift's own
// scoping. Codepoints (sf_symbols.codepoint, stamped by a SEPARATE command) are NOT needed here:
// `SymbolPdf.render` resolves symbols by NAME (`NSImage(systemSymbolName:)` / `Bundle.image(
// forResource:)`), never by Unicode codepoint — the JS codepoint-stamp step's ~71.6% coverage gap
// is a different feature's limitation and doesn't bound this pass. The real, unavoidable failure
// mode here is a catalog entry newer than the running macOS's CoreGlyphs bundle (mark-unrenderable.js's
// concern) — degraded gracefully below (§ markUnsupported), never aborting the whole run.

import ADJSONCore
import ADStorage
import ArgumentParser
import Foundation

/// One stderr write via the throwing `FileHandle.write(contentsOf:)` — NOT the older
/// `FileHandle.write(_:)`, which raises an uncaught `NSException` (aborting the whole process:
/// observed in practice under this command's own output backpressure during a long run) on a
/// failed write. A diagnostic/progress line must never abort a 273K-item batch pass, so any write
/// failure here is silently dropped.
private func writeStderr(_ text: String) {
    try? FileHandle.standardError.write(contentsOf: Data(text.utf8))
}

#if canImport(AppKit)
    import ADRender
    import Crypto

    /// A single-threaded progress counter, boxed in a reference type so the `onProgress` callback
    /// (declared `@Sendable` by `SymbolPrerender.run`) can update it without Swift 6 flagging a
    /// captured-`var` mutation — the callback is only ever invoked from `run`'s own serial
    /// consuming loop, never concurrently, so `@unchecked Sendable` here documents a real invariant
    /// rather than suppressing one (the same pattern `StorageConnection` itself uses).
    private final class ProgressThrottle: @unchecked Sendable {
        var lastReported = 0
    }
#endif

/// `ad-cli resources prerender-symbols [--db --home --scope --concurrency --limit --json]`.
struct ResourcesPrerenderSymbolsCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "prerender-symbols",
        abstract: "Bake every SF Symbol x weight x scale variant to SVG, cached in sf_symbol_renders.")

    @Option(name: .long, help: "Path to the writable corpus DB (default: <home>/apple-docs.db).")
    var db: String?

    @Option(name: .long, help: "Corpus home (default: $APPLE_DOCS_HOME, else ~/.apple-docs).")
    var home: String?

    // Deliberately OPTIONAL (unlike sync-symbols' `--scope` default "public"): the JS prerender's own
    // default spans BOTH scopes in one pass (`prerenderSfSymbols`'s `scopeFilter` is nil unless the
    // caller narrows it), and this verb mirrors that default.
    @Option(name: .long, help: "Symbol scope: public, private, or omit for both (default: both).")
    var scope: String?

    @Option(name: .long, help: "Max concurrent render tasks in flight (default: active core count).")
    var concurrency: Int?

    @Option(name: .long, help: "Cap the number of symbols processed, for a sampled/partial run.")
    var limit: Int?

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func validate() throws {
        if let scope, scope != "public", scope != "private" {
            throw ValidationError("--scope must be 'public' or 'private'")
        }
        if let concurrency, concurrency < 1 {
            throw ValidationError("--concurrency must be >= 1")
        }
        if let limit, limit < 1 {
            throw ValidationError("--limit must be >= 1")
        }
    }

    func run() async throws {
        #if canImport(AppKit)
            let dataDir =
                home ?? ProcessInfo.processInfo.environment["APPLE_DOCS_HOME"]
                ?? "\(NSHomeDirectory())/.apple-docs"
            let dbPath = db ?? "\(dataDir)/apple-docs.db"
            guard let connection = StorageConnection(path: dbPath) else {
                writeStderr("ad-cli: cannot open corpus \(dbPath)\n")
                throw ExitCode(1)
            }

            let selected = selectSymbols(connection)
            let refs = selected.map { SymbolPrerender.SymbolRef(scope: $0.scope, name: $0.name) }
            let width = concurrency ?? Swift.max(1, ProcessInfo.processInfo.activeProcessorCount)

            let throttle = ProgressThrottle()
            let start = Date()
            let outcome = await SymbolPrerender.run(
                symbols: refs, dataDir: dataDir, concurrency: width, db: connection, now: jsIsoNow
            ) { stats in
                reportProgress(stats, throttle: throttle)
            }
            let elapsedSeconds = Date().timeIntervalSince(start)

            for ref in outcome.unsupported {
                connection.markSfSymbolRenderUnsupported(scope: ref.scope, name: ref.name)
            }
            let sample = outcome.sampleCacheKey.flatMap { connection.getSfSymbolRender(cacheKey: $0) }

            emit(
                scope: scope ?? "both", symbolCount: selected.count, outcome: outcome,
                elapsedSeconds: elapsedSeconds, sample: sample)
        #else
            writeStderr("ad-cli: resources prerender-symbols needs AppKit — unavailable on this platform\n")
            throw ExitCode(1)
        #endif
    }

    #if canImport(AppKit)
        /// The catalog slice this run considers: scope-filtered, minus catalog meta-rows and symbols
        /// already flagged unrenderable on this host, then capped by `--limit` (first N in the
        /// established `scope, order_index, name` catalog order — deterministic + reproducible).
        private func selectSymbols(_ connection: StorageConnection) -> [SfCatalogRow] {
            let requestedScope = scope
            let catalog =
                connection.listSfSymbolsCatalog()
                .filter { requestedScope == nil || $0.scope == requestedScope }
                .filter { !SymbolPrerender.catalogMetaNames.contains($0.name) }
                .filter { ($0.renderUnsupported ?? 0) == 0 }
            return limit.map { Array(catalog.prefix($0)) } ?? catalog
        }

        /// Emit a stderr progress line roughly every 500 processed variants (or on completion) — a
        /// long (potentially hours-long, full-corpus) run stays observable rather than a silent black
        /// box, mirroring `CrawlDriver`'s own progress-interval philosophy.
        private func reportProgress(_ stats: SymbolPrerender.Stats, throttle: ProgressThrottle) {
            let processed = stats.rendered + stats.skipped + stats.failed
            guard processed - throttle.lastReported >= 500 || processed == stats.totalVariants else { return }
            throttle.lastReported = processed
            let line =
                "ad-cli: prerender-symbols: \(processed)/\(stats.totalVariants) processed "
                + "(rendered \(stats.rendered), skipped \(stats.skipped), failed \(stats.failed))\n"
            writeStderr(line)
        }

        private func emit(
            scope: String, symbolCount: Int, outcome: SymbolPrerender.Outcome, elapsedSeconds: Double,
            sample: SfSymbolRenderRow?
        ) {
            if json {
                print(
                    stringifyPretty(
                        jsonResult(
                            scope: scope, symbolCount: symbolCount, outcome: outcome,
                            elapsedSeconds: elapsedSeconds, sample: sample)))
                return
            }
            print(
                "prerender-symbols: \(symbolCount) symbols x \(SymbolPrerender.variantCount) variants "
                    + "(\(outcome.stats.totalVariants) total) — rendered \(outcome.stats.rendered), "
                    + "skipped \(outcome.stats.skipped), failed \(outcome.stats.failed), "
                    + "\(outcome.unsupported.count) symbols marked unsupported "
                    + "(\(String(format: "%.1f", elapsedSeconds))s)")
            if let sample {
                print("  sample cached render: \(sample.filePath) (\(sample.size ?? 0) bytes)")
            }
        }

        private func jsonResult(
            scope: String, symbolCount: Int, outcome: SymbolPrerender.Outcome, elapsedSeconds: Double,
            sample: SfSymbolRenderRow?
        ) -> JSONValue {
            .obj([
                ("scope", .string(scope)),
                ("symbolsConsidered", .int(Int64(symbolCount))),
                ("variantsTotal", .int(Int64(outcome.stats.totalVariants))),
                ("rendered", .int(Int64(outcome.stats.rendered))),
                ("skipped", .int(Int64(outcome.stats.skipped))),
                ("failed", .int(Int64(outcome.stats.failed))),
                ("unsupportedSymbols", .int(Int64(outcome.unsupported.count))),
                ("elapsedSeconds", .number((elapsedSeconds * 100).rounded() / 100)),
                ("sampleFilePath", sample.map { JSONValue.string($0.filePath) } ?? .null),
                ("sampleFileSize", sample?.size.map { .int($0) } ?? .null),
                (
                    "failures",
                    .array(
                        outcome.failures.prefix(20)
                            .map { failure in
                                JSONValue.obj([
                                    ("scope", .string(failure.scope)), ("name", .string(failure.name)),
                                    ("weight", .string(failure.weight)), ("scale", .string(failure.scale)),
                                    ("reason", .string(failure.reason))
                                ])
                            })
                )
            ])
        }
    #endif
}

#if canImport(AppKit)
    /// The prerender pass: (symbol x variant) -> theme-neutral SVG -> `sf_symbol_renders` row.
    /// Reused by nothing else today; kept as its own namespace (rather than folded into the command)
    /// so the concurrency/persistence logic is unit-testable independent of ArgumentParser.
    enum SymbolPrerender {
        /// Catalog meta-entries with no drawable glyph (the JS `CATALOG_META_NAMES`) — defense in
        /// depth. `SymbolSync.syncSfSymbols` already filters these at ingest, but a snapshot carrying
        /// stale pre-filter rows shouldn't burn render attempts on them.
        static let catalogMetaNames: Set<String> = ["symbols", "year_to_release"]

        /// The full weight x scale matrix (apple-symbols/cache-key.js `SYMBOL_WEIGHTS`/
        /// `SYMBOL_SCALES`) — identical for both scopes.
        static let weights = [
            "ultralight", "thin", "light", "regular", "medium", "semibold", "bold", "heavy", "black"
        ]
        static let scales = ["small", "medium", "large"]
        static var variantCount: Int { weights.count * scales.count }

        /// A theme-neutral baseline render's fixed parameters (apple-symbols/prerender-engine.js
        /// `writeSymbolSvg`: `SYMBOL_DEFAULT_RENDER_SIZE`, black fill, no background).
        static let defaultPointSize = 128
        static let defaultColor = "#000000"
        static let defaultFormat = "svg"
        static let mimeType = "image/svg+xml; charset=utf-8"

        /// A bound on how many per-item failure details are retained for reporting — the run itself
        /// never stops early, this only caps memory for a pathological (e.g. very-old-macOS) run
        /// where most of a quarter-million attempts fail.
        private static let maxRetainedFailures = 500

        struct Stats: Sendable, Equatable {
            var totalVariants = 0
            var rendered = 0
            var skipped = 0
            var failed = 0
        }

        struct Failure: Sendable {
            let scope: String
            let name: String
            let weight: String
            let scale: String
            let reason: String
        }

        struct SymbolRef: Sendable, Hashable {
            let scope: String
            let name: String
        }

        struct Outcome: Sendable {
            var stats = Stats()
            var failures: [Failure] = []
            var unsupported: [SymbolRef] = []
            /// The cache key of the first row upserted this run — the CLI verb re-reads this row
            /// after the run as a real, independent (write, then fresh read) verification.
            var sampleCacheKey: String?
        }

        private struct Job: Sendable {
            let scope: String
            let name: String
            let weight: String
            let scale: String
        }

        private enum JobResult: Sendable {
            case rendered(Job, [UInt8])
            case failed(Job, String)
        }

        /// Bake every (symbol x variant) not already on disk into a theme-neutral SVG, upserted into
        /// `sf_symbol_renders`. Mirrors `ADBuilderPipeline.CrawlDriver`'s "concurrent CPU-bound work,
        /// single-writer serial persist" shape: child tasks only call `SymbolPdf`/`SymbolPdfToSvg`
        /// (pure — no `db`, no filesystem); this function's own serial consuming loop is the only
        /// writer, so `db` never crosses a task boundary.
        static func run(
            symbols: [SymbolRef], dataDir: String, concurrency: Int, db: StorageConnection,
            now: @escaping @Sendable () -> String, onProgress: (@Sendable (Stats) -> Void)? = nil
        ) async -> Outcome {
            var outcome = Outcome()
            let queue = buildQueue(symbols: symbols, dataDir: dataDir, outcome: &outcome, onProgress: onProgress)

            var failedCountBySymbol: [SymbolRef: Int] = [:]
            var iterator = queue.makeIterator()
            let width = Swift.max(1, concurrency)
            await withTaskGroup(of: JobResult.self) { group in
                for _ in 0 ..< width {
                    guard let job = iterator.next() else { break }
                    group.addTask { renderOne(job) }
                }
                while let result = await group.next() {
                    handle(
                        result, dataDir: dataDir, db: db, now: now(), outcome: &outcome,
                        failedCountBySymbol: &failedCountBySymbol)
                    onProgress?(outcome.stats)
                    if let job = iterator.next() {
                        group.addTask { renderOne(job) }
                    }
                }
            }

            markUnsupported(symbols: symbols, failedCountBySymbol: failedCountBySymbol, outcome: &outcome)
            return outcome
        }

        /// Build the job queue, skipping variants already rendered on disk (resume-safety, mirroring
        /// the JS `existsSync(filePath) && statSync(filePath).size > 0` pre-check). Deterministic SVG
        /// content (fnv1a mask ids, no `Math.random()` — rfcs/0003 records.md Phase 2) makes this safe
        /// to trust across reruns: a file that exists already holds the SAME bytes a fresh render
        /// would produce.
        private static func buildQueue(
            symbols: [SymbolRef], dataDir: String, outcome: inout Outcome, onProgress: (@Sendable (Stats) -> Void)?
        ) -> [Job] {
            var queue: [Job] = []
            queue.reserveCapacity(symbols.count * variantCount)
            for symbol in symbols {
                for weight in weights {
                    for scale in scales {
                        outcome.stats.totalVariants += 1
                        let path = prerenderedSymbolPath(
                            dataDir: dataDir, scope: symbol.scope, name: symbol.name, weight: weight, scale: scale)
                        if let size = fileSize(at: path), size > 0 {
                            outcome.stats.skipped += 1
                            onProgress?(outcome.stats)
                            continue
                        }
                        queue.append(Job(scope: symbol.scope, name: symbol.name, weight: weight, scale: scale))
                    }
                }
            }
            return queue
        }

        /// Apply one completed child task's result to `outcome` (and, for a success, to disk/db) —
        /// the sole per-result handler the serial consuming loop calls.
        private static func handle(
            _ result: JobResult, dataDir: String, db: StorageConnection, now: String, outcome: inout Outcome,
            failedCountBySymbol: inout [SymbolRef: Int]
        ) {
            switch result {
                case .rendered(let job, let svg):
                    persist(job, svg: svg, dataDir: dataDir, db: db, now: now, outcome: &outcome)
                case .failed(let job, let reason):
                    recordFailure(
                        Failure(scope: job.scope, name: job.name, weight: job.weight, scale: job.scale, reason: reason),
                        into: &outcome)
                    failedCountBySymbol[SymbolRef(scope: job.scope, name: job.name), default: 0] += 1
            }
        }

        /// Mirrors the JS `markUnrenderableSymbols`: a symbol whose EVERY attempted variant failed
        /// this run is flagged `render_unsupported` so a resumed/future pass (and the live MCP
        /// handler's existing pre-check) can short-circuit it. A symbol with any SKIPPED (i.e.
        /// previously-succeeded) variant can never reach `variantCount` failures in one run, so this
        /// can't misfire on a partially-baked-in-a-prior-run symbol.
        private static func markUnsupported(
            symbols: [SymbolRef], failedCountBySymbol: [SymbolRef: Int], outcome: inout Outcome
        ) {
            for symbol in symbols where (failedCountBySymbol[symbol] ?? 0) == variantCount {
                outcome.unsupported.append(symbol)
            }
        }

        private static func recordFailure(_ failure: Failure, into outcome: inout Outcome) {
            outcome.stats.failed += 1
            if outcome.failures.count < maxRetainedFailures { outcome.failures.append(failure) }
        }

        /// One render, entirely synchronous/CPU-bound — no `db`, no filesystem. Concurrent in-process
        /// AppKit symbol rendering across many such calls is proven crash-free + byte-identical
        /// (D-0003-3 Probe A) — the exact operation `ad_render_symbol_pdf_batch`'s
        /// `DispatchQueue.concurrentPerform` already runs at scale.
        private static func renderOne(_ job: Job) -> JobResult {
            guard let pdf = SymbolPdf.render(name: job.name, scope: job.scope, weight: job.weight, scale: job.scale)
            else {
                return .failed(job, "render produced no output (absent on this macOS, or genuinely unrenderable)")
            }
            do {
                let svg = try SymbolPdfToSvg.convert(
                    pdf,
                    options: .init(name: job.name, pointSize: defaultPointSize, color: defaultColor, background: nil))
                return .rendered(job, Array(svg.utf8))
            } catch {
                return .failed(job, "SVG conversion failed: \(error)")
            }
        }

        /// Write the SVG to its deterministic snapshot path + upsert the `sf_symbol_renders` row. The
        /// ONLY place this driver touches disk/db — always called from the single serial consumer
        /// loop, never concurrently.
        private static func persist(
            _ job: Job, svg: [UInt8], dataDir: String, db: StorageConnection, now: String, outcome: inout Outcome
        ) {
            let path = prerenderedSymbolPath(
                dataDir: dataDir, scope: job.scope, name: job.name, weight: job.weight, scale: job.scale)
            do {
                try ensureParentDirectory(of: path)
                try Data(svg).write(to: URL(fileURLWithPath: path), options: .atomic)
            } catch {
                recordFailure(
                    Failure(
                        scope: job.scope, name: job.name, weight: job.weight, scale: job.scale,
                        reason: "file write failed: \(error)"),
                    into: &outcome)
                return
            }
            let cacheKey = SymbolRenderCacheKey.compute(
                .init(
                    scope: job.scope, name: job.name, format: defaultFormat, weight: job.weight, scale: job.scale,
                    color: defaultColor, pointSize: defaultPointSize))
            let row = SfSymbolRenderUpsert(
                cacheKey: cacheKey, name: job.name, scope: job.scope, format: defaultFormat, mode: "prerender",
                weight: job.weight, symbolScale: job.scale, pointSize: defaultPointSize, color: defaultColor,
                filePath: path, mimeType: mimeType, sha256: sha256Hex(svg), size: Int64(svg.count))
            guard db.upsertSfSymbolRender(row, updatedAt: now) else {
                recordFailure(
                    Failure(
                        scope: job.scope, name: job.name, weight: job.weight, scale: job.scale,
                        reason: "sf_symbol_renders upsert failed"),
                    into: &outcome)
                return
            }
            outcome.stats.rendered += 1
            if outcome.sampleCacheKey == nil { outcome.sampleCacheKey = cacheKey }
        }

        private static func sha256Hex(_ bytes: [UInt8]) -> String {
            SHA256.hash(data: Data(bytes)).map { String(format: "%02x", $0) }.joined()
        }

        private static func fileSize(at path: String) -> Int64? {
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
            return (attrs[.size] as? NSNumber)?.int64Value
        }

        private static func ensureParentDirectory(of path: String) throws {
            let dir = (path as NSString).deletingLastPathComponent
            try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        }

        /// `getPrerenderedSymbolPath` (apple-symbols/cache-key.js): the flat snapshot layout —
        /// `<dataDir>/resources/symbols/<scope>/<name>.svg` at the regular/medium default, else
        /// `<dataDir>/resources/symbols/<scope>/<weight>-<scale>/<name>.svg`.
        static func prerenderedSymbolPath(
            dataDir: String, scope: String, name: String, weight: String, scale: String
        ) -> String {
            let cleanScope = scope == "private" ? "private" : "public"
            let fileName = "\(sanitizeFileName(name)).svg"
            if weight == "regular", scale == "medium" {
                return "\(dataDir)/resources/symbols/\(cleanScope)/\(fileName)"
            }
            return "\(dataDir)/resources/symbols/\(cleanScope)/\(weight)-\(scale)/\(fileName)"
        }

        /// `sanitizeFileName` (apple-assets-helpers.js): collapse runs of characters outside
        /// `[A-Za-z0-9_.-]` to a single `-`, trim leading/trailing `-`, empty -> `"asset"`.
        static func sanitizeFileName(_ value: String) -> String {
            var result = ""
            result.reserveCapacity(value.utf8.count)
            var lastWasDash = false
            for scalar in value.unicodeScalars {
                let v = scalar.value
                let allowed =
                    (v >= 0x30 && v <= 0x39) || (v >= 0x41 && v <= 0x5A) || (v >= 0x61 && v <= 0x7A)
                    || scalar == "_" || scalar == "." || scalar == "-"
                if allowed {
                    result.unicodeScalars.append(scalar)
                    lastWasDash = false
                } else if !lastWasDash {
                    result.append("-")
                    lastWasDash = true
                }
            }
            while result.hasPrefix("-") { result.removeFirst() }
            while result.hasSuffix("-") { result.removeLast() }
            return result.isEmpty ? "asset" : result
        }
    }
#endif
