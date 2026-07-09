// The WS-D write verbs beyond `crawl`: `index` (embedding index), `sync`
// (crawl + body-index + embed-index for one source), `sync-all` (every native
// source), and `snapshot` (the distributable corpus archive) — thin wiring over
// IndexBody.run* / IndexEmbeddings.run / CrawlDriver.sync / Snapshot.build. All
// operate on a writable SQLite corpus (the JS `bun:sqlite` format — the storage
// pivot), like `ad-cli crawl`.

import ADBuilder
import ADBuilderPipeline
import ADEmbed
import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

extension SourceRegistry {
    /// The natively-ported adapters, in one place (the crawl/sync verbs + the
    /// entry-point registry all build from this list).
    static let nativeAdapterTypes: [any SourceAdapter.Type] = [
        SwiftOrgAdapter.self, SwiftBookAdapter.self, SwiftEvolutionAdapter.self,
        GuidelinesAdapter.self, AppleArchiveAdapter.self, SwiftDoccAdapter.self,
        PackagesAdapter.self, SampleCodeAdapter.self, ExternalDoccAdapter.self,
        WwdcAdapter.self, HigAdapter.self, AppleDoccAdapter.self
    ]

    static var nativeSourceNames: String {
        nativeAdapterTypes.map { $0.type }.sorted().joined(separator: ", ")
    }
}

/// Open (creating + migrating) the writable SQLite corpus the write verbs share.
func openCrawlCorpus(_ path: String) throws -> SQLiteWriteConnection {
    do {
        let database = try SQLiteWriteConnection(path: path)
        _ = try migrateSchema(database)
        return database
    } catch {
        FileHandle.standardError.write(Data("ad-cli: cannot open/migrate \(path): \(error)\n".utf8))
        throw ExitCode(1)
    }
}

/// The potion embedder for the index verbs — resolved from the corpus-adjacent
/// resources tree (`<dataDir>/resources/models/minishlab/potion-retrieval-32M`),
/// exactly where `search`'s semantic tier loads it from.
func loadIndexEmbedder(dbPath: String) throws -> Embedder {
    let dataDir = (dbPath as NSString).deletingLastPathComponent
    let modelDir = dataDir + "/resources/models/minishlab/potion-retrieval-32M"
    do {
        return try loadPotionEmbedder(modelDir: modelDir)
    } catch {
        FileHandle.standardError.write(
            Data(
                "ad-cli: no embedder at \(modelDir) (\(error)) — run against a data dir with the model resources\n".utf8
            ))
        throw ExitCode(1)
    }
}

/// `loadIndexEmbedder` for the SYNC verbs: nil-with-a-warning instead of exit-1 when the
/// model resources are absent — the JS sync's behavior (its semantic tier goes dormant and
/// the run succeeds). The explicit `ad-cli index` verb keeps the hard failure: there the
/// user asked for exactly the thing that can't run.
func loadIndexEmbedderIfAvailable(dbPath: String) -> Embedder? {
    let dataDir = (dbPath as NSString).deletingLastPathComponent
    let modelDir = dataDir + "/resources/models/minishlab/potion-retrieval-32M"
    do {
        return try loadPotionEmbedder(modelDir: modelDir)
    } catch {
        FileHandle.standardError.write(
            Data(
                "ad-cli: semantic index skipped — no embedder at \(modelDir) (\(error)); install the model resources (apple-docs setup) to enable the semantic tier\n"
                    .utf8))
        return nil
    }
}

/// Build the crawl HTTP context. A bulk crawl is throughput-bound, not politeness-bound, so this
/// mirrors the JS `sync` budget (rate 500 req/s — `config.js` `APPLE_DOCS_RATE` sync default) rather
/// than the interactive 5 req/s; `burst` = the rate so a `--concurrency`-deep first wave isn't stalled
/// on an empty token bucket.
func crawlContext(rate: Double, concurrency: Int) -> SourceContext {
    // Each URLSession is one HTTP/2 connection to the origin, and the server caps ~65 in-flight
    // streams per connection — so a single session plateaus a wide crawl at ~60 pages/s regardless
    // of concurrency. A small pool lifts that: measured ~60 -> ~70 pages/s. The pool stays small
    // because the SERIAL per-page persist (~70 pages/s, single-writer) is the dominant ceiling —
    // two connections already over-feed it, so more just open idle sockets against the origin.
    let connections = Swift.max(1, Swift.min(4, concurrency / 128))
    return SourceContext(
        client: URLSessionHTTPClient(maxConnectionsPerHost: concurrency, connections: connections),
        rateLimiter: RateLimiter(rate: rate, burst: Swift.max(rate, 1)))
}

/// `ad-cli index …` — the search-index verb group, mirroring the JS `apple-docs
/// index <subcommand>` shape: `embeddings` (the semantic tier — also the
/// DEFAULT, so the historical `ad-cli index --db <DB> [--full]` invocation
/// keeps working) and `rebuild [body|trigram]` (the lexical FTS5 rebuilds).
/// A pure group: a parent command must NOT declare its own options next to
/// subcommands — ArgumentParser matches parent-declared names (`--db`) across
/// the whole line, silently stealing them from the subcommand.
struct IndexCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "index",
        abstract: "Build or rebuild search indexes over a crawled SQLite corpus.",
        subcommands: [IndexEmbeddingsCommand.self, IndexRebuildCommand.self],
        defaultSubcommand: IndexEmbeddingsCommand.self)
}

/// `ad-cli index [embeddings] --db <DB> [--full]` — build/resume the embedding
/// index over everything persisted (IndexEmbeddings.run; the post-crawl pass
/// that makes crawled pages searchable).
struct IndexEmbeddingsCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "embeddings",
        abstract: "Build or resume the embedding index over a crawled SQLite corpus.")

    @Option(name: .long, help: "Path to the writable SQLite corpus.")
    var db: String

    @Flag(name: .long, help: "Re-embed every document (else resume: only documents with no chunks).")
    var full = false

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let database = try openCrawlCorpus(db)
        // A missing embedder is a SOFT outcome, byte-matching the JS oracle
        // (index-embeddings.js returns {status:'error', message} and cli.js's
        // summary formatter prints it with exit 0 — no hard failure). The
        // message text is the JS's verbatim, Bun-era advice included, so the
        // flip stays byte-faithful; it gets reworded when the oracle freezes
        // at I2.
        guard let embedder = loadIndexEmbedderIfAvailable(dbPath: db) else {
            let envelope = JSONValue.obj([
                ("status", .string("error")),
                (
                    "message",
                    .string(
                        "Semantic embedder unavailable. The default model is native: fetch the bundle with `apple-docs setup --native` and keep APPLE_DOCS_NATIVE enabled (gated models additionally need `bun add @huggingface/transformers`)."
                    )
                )
            ])
            print(json ? stringifyPretty(envelope) : "index embeddings: \(stringifyCompact(envelope))")
            return
        }
        let result: IndexEmbeddings.Result
        do {
            result = try IndexEmbeddings.run(database, embedder: embedder, full: full)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: index failed: \(error)\n".utf8))
            throw ExitCode(1)
        }
        // cli.js prints via the maintenance `summary('index embeddings')`
        // formatter — `index embeddings: <JSON.stringify(result)>` — and the
        // global --json path prints the raw result pretty.
        if json {
            print(stringifyPretty(indexResultJSON(result)))
        } else {
            print("index embeddings: \(stringifyCompact(indexResultJSON(result)))")
        }
    }
}

/// `ad-cli sync <source> --db <DB>` — crawl one source, then body-index and
/// embed-index it (CrawlDriver.sync — the native mirror of cli.js sync's
/// crawl + body-index for one source, plus the embedding index).
struct SyncCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync",
        abstract: "Crawl one source into a SQLite corpus, then build its body + embedding indexes.")

    @Argument(help: "Source to sync (native adapters only).")
    var source: String

    @Option(name: .long, help: "Path to the writable SQLite corpus (created + migrated if missing).")
    var db: String

    @Option(name: .long, help: "Max concurrent fetch+normalize tasks in flight (default 256).")
    var concurrency: Int = 256

    @Option(name: .long, help: "Client-side rate-limiter budget in requests/sec (default 2000).")
    var rate: Double = 2000

    @Flag(name: .long, help: "Emit the stats as JSON.")
    var json = false

    func run() async throws {
        let registry = SourceRegistry(SourceRegistry.nativeAdapterTypes)
        let adapter: any SourceAdapter
        do {
            adapter = try registry.adapter(for: source)
        } catch {
            FileHandle.standardError.write(
                Data(
                    "ad-cli: unknown or not-yet-ported source '\(source)' (native: \(SourceRegistry.nativeSourceNames))\n"
                        .utf8))
            throw ExitCode(1)
        }
        let database = try openCrawlCorpus(db)
        let embedder = loadIndexEmbedderIfAvailable(dbPath: db)
        let now = jsIsoNow()
        let context = crawlContext(rate: rate, concurrency: concurrency)

        let result: CrawlDriver.SyncResult
        do {
            let discovery = try await adapter.discover(context)
            guard !discovery.roots.isEmpty else {
                FileHandle.standardError.write(Data("ad-cli: source '\(source)' discovered no root\n".utf8))
                throw ExitCode(1)
            }
            let (rootId, rootIds) = try upsertCrawlRoots(database, discovery.roots, now: now)
            result = try await CrawlDriver(registry: registry)
                .sync(
                    sourceType: source, into: database, rootId: rootId, rootIds: rootIds, context: context,
                    now: now, embedder: embedder)
        } catch let code as ExitCode {
            throw code
        } catch {
            FileHandle.standardError.write(Data("ad-cli: sync \(source) failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("source", .string(source)),
                        ("discovered", .int(Int64(result.crawl.discovered))),
                        ("persisted", .int(Int64(result.crawl.persisted))),
                        ("skipped", .int(Int64(result.crawl.skipped))),
                        ("failed", .int(Int64(result.crawl.failed))),
                        ("bodyIndexed", .int(Int64(result.body.indexed))),
                        ("index", indexResultJSON(result.index))
                    ])))
        } else {
            print(
                "synced \(source): discovered \(result.crawl.discovered), persisted \(result.crawl.persisted), "
                    + "skipped \(result.crawl.skipped), failed \(result.crawl.failed); "
                    + "body \(result.body.indexed) indexed; index \(indexResultSummary(result.index))")
        }
    }
}

/// `ad-cli sync-all --db <DB>` — crawl EVERY native source into the corpus (each
/// source's discover → upsert-roots → crawl, flat or BFS per its syncMode), then build
/// the body index (the JS sync's post-crawl phase) and the embedding index once. The
/// native mirror of `bun cli.js sync` over all sources; one source's failure is logged
/// and never aborts the run.
struct SyncAllCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-all",
        abstract: "Crawl every native source into a SQLite corpus, then build the body + embedding indexes once.")

    @Option(name: .long, help: "Path to the writable SQLite corpus (created + migrated if missing).")
    var db: String

    @Option(name: .long, help: "Max concurrent fetch+normalize tasks in flight (default 256).")
    var concurrency: Int = 256

    @Option(name: .long, help: "Client-side rate-limiter budget in requests/sec (default 2000).")
    var rate: Double = 2000

    @Option(name: .long, help: "Comma-separated source subset (default: all native sources).")
    var only: String?

    @Flag(name: .long, help: "Crawl only — skip the final embedding-index pass.")
    var skipIndex = false

    func run() async throws {
        let registry = SourceRegistry(SourceRegistry.nativeAdapterTypes)
        let database = try openCrawlCorpus(db)
        let context = crawlContext(rate: rate, concurrency: concurrency)
        let driver = CrawlDriver(registry: registry)

        let sources =
            only.map { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
            ?? SourceRegistry.nativeAdapterTypes.map { $0.type }

        var totals = CrawlDriver.Stats()
        for source in sources {
            let now = jsIsoNow()
            do {
                FileHandle.standardError.write(Data("[\(source)] discovering entry points…\n".utf8))
                let adapter = try registry.adapter(for: source)
                let discovery = try await adapter.discover(context)
                guard !discovery.roots.isEmpty else {
                    FileHandle.standardError.write(
                        Data("ad-cli: sync-all: '\(source)' discovered no root; skipping\n".utf8))
                    continue
                }
                let (rootId, rootIds) = try upsertCrawlRoots(database, discovery.roots, now: now)
                let seeded = "[\(source)] \(discovery.roots.count) root(s) seeded — crawling…\n"
                FileHandle.standardError.write(Data(seeded.utf8))
                let sourceStart = Date()
                let stats = try await driver.crawl(
                    sourceType: source, into: database, rootId: rootId, rootIds: rootIds,
                    context: context, now: now, maxConcurrency: concurrency,
                    onProgress: { progress in
                        // A long reference-following source (apple-docc: ~350K pages) is otherwise a
                        // silent black box until it completes; stream elapsed time, running counts,
                        // and cumulative throughput to stderr so a stall (lines stop) is obvious.
                        let secs = Date().timeIntervalSince(sourceStart)
                        let pps = secs > 0 ? Int(Double(progress.persisted) / secs) : 0
                        let line =
                            "[\(source)] \(Int(secs))s … \(progress.persisted) persisted, "
                            + "\(progress.failed) failed (\(pps)/s)\n"
                        FileHandle.standardError.write(Data(line.utf8))
                    })
                totals.discovered += stats.discovered
                totals.persisted += stats.persisted
                totals.skipped += stats.skipped
                totals.failed += stats.failed
                print(
                    "[\(source)] discovered \(stats.discovered), persisted \(stats.persisted), "
                        + "skipped \(stats.skipped), failed \(stats.failed)")
            } catch {
                FileHandle.standardError.write(
                    Data("ad-cli: sync-all: '\(source)' failed: \(error) — continuing\n".utf8))
            }
        }
        print(
            "crawled \(sources.count) sources: discovered \(totals.discovered), "
                + "persisted \(totals.persisted), skipped \(totals.skipped), failed \(totals.failed)")

        // The JS sync's post-crawl body-index phase runs unconditionally (the JS has
        // no knob to skip it); --skip-index skips only the embedding pass.
        let bodyResult = try IndexBody.runIncremental(database, now: jsIsoNow())
        print("Body index complete: \(bodyResult.indexed) documents indexed, \(bodyResult.errors) errors")

        if !skipIndex {
            if let embedder = loadIndexEmbedderIfAvailable(dbPath: db) {
                let indexResult = try driver.index(database, embedder: embedder)
                print("index: \(indexResultSummary(indexResult))")
            } else {
                print("index: skipped (no embedder)")
            }
        }
    }
}

/// `ad-cli snapshot --db <DB> --out <dir> --tag <snapshot-YYYYMMDD>` — build
/// the distributable snapshot archive (Snapshot.build; deterministic
/// createdAt/mtimes derive from the tag).
struct SnapshotCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "snapshot",
        abstract: "Build the distributable snapshot archive from a SQLite corpus.")

    @Option(name: .long, help: "Path to the SQLite corpus to snapshot.")
    var db: String

    @Option(name: .long, help: "Output directory for the archive + checksum + manifest.")
    var out: String

    @Option(name: .long, help: "Snapshot tag (e.g. snapshot-20260702; determinism derives from it).")
    var tag: String

    @Option(name: .customLong("data-dir"), help: "Data dir with raw-json/markdown trees to include (optional).")
    var dataDir: String?

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let database = try openCrawlCorpus(db)
        let schemaVersion: Int64
        do {
            schemaVersion = Int64(try migrateSchema(database).finalVersion)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: cannot read schema version: \(error)\n".utf8))
            throw ExitCode(1)
        }
        let result: Snapshot.Result
        do {
            result = try Snapshot.build(
                database, dataDir: dataDir, outDir: out, tag: tag, schemaVersion: schemaVersion)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: snapshot failed: \(error)\n".utf8))
            throw ExitCode(1)
        }
        if json {
            print(stringifyPretty(snapshotResultJSON(result)))
        } else {
            print("snapshot built: \(result.archivePath)")
        }
    }
}

// MARK: - result projections

private func indexResultJSON(_ result: IndexEmbeddings.Result) -> JSONValue {
    // The JS `{ status, indexed, total, chunks }` return shape.
    .obj([
        ("status", .string(result.status)),
        ("indexed", .int(Int64(result.indexed))),
        ("total", .int(Int64(result.total))),
        ("chunks", .int(Int64(result.chunks)))
    ])
}

private func indexResultSummary(_ result: IndexEmbeddings.Result) -> String {
    "\(result.status): \(result.indexed)/\(result.total) documents, \(result.chunks) chunks"
}

private func snapshotResultJSON(_ result: Snapshot.Result) -> JSONValue {
    .obj([
        ("tag", .string(result.tag)),
        ("documentCount", .int(Int64(result.documentCount))),
        ("archivePath", .string(result.archivePath)),
        ("archiveSize", .int(result.archiveSize)),
        ("archiveChecksum", .string(result.archiveChecksum)),
        ("checksumSidecarPath", .string(result.checksumSidecarPath)),
        ("manifestPath", .string(result.manifestPath))
    ])
}
