// The WS-D write verbs beyond `crawl`: `index` (embedding index), `sync`
// (crawl + index for one source), and `snapshot` (the distributable corpus
// archive) — thin wiring over IndexEmbeddings.run / CrawlDriver.sync /
// Snapshot.build. All operate on a writable ADDB corpus (the native crawl
// store), like `ad-cli crawl`.

import ADBuilder
import ADBuilderPipeline
import ADDB
// ADDBMigrate: Migrator.Outcome members (finalVersion) — MemberImportVisibility.
import ADDBMigrate
import ADEmbed
import ADJSONCore
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

/// Open (creating + migrating) the writable ADDB corpus the write verbs share.
func openCrawlCorpus(_ path: String) throws -> Database {
    do {
        let database = try Database.open(
            at: path, options: DatabaseOptions(readOnly: false, createIfMissing: true))
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

/// Build the crawl HTTP context. A bulk crawl is throughput-bound, not politeness-bound, so this
/// mirrors the JS `sync` budget (rate 500 req/s — `config.js` `APPLE_DOCS_RATE` sync default) rather
/// than the interactive 5 req/s; `burst` = the rate so a `--concurrency`-deep first wave isn't stalled
/// on an empty token bucket.
func crawlContext(rate: Double, concurrency: Int) -> SourceContext {
    SourceContext(
        client: URLSessionHTTPClient(maxConnectionsPerHost: concurrency),
        rateLimiter: RateLimiter(rate: rate, burst: Swift.max(rate, 1)))
}

/// `ad-cli index --db <ADDB> [--full]` — build/resume the embedding index over
/// everything persisted (IndexEmbeddings.run; the post-crawl pass that makes
/// crawled pages searchable).
struct IndexCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "index",
        abstract: "Build or resume the embedding index over a crawled ADDB corpus.")

    @Option(name: .long, help: "Path to the writable ADDB corpus.")
    var db: String

    @Flag(name: .long, help: "Re-embed every document (else resume: only documents with no chunks).")
    var full = false

    @Flag(name: .long, help: "Emit the result as JSON.")
    var json = false

    func run() throws {
        let database = try openCrawlCorpus(db)
        let embedder = try loadIndexEmbedder(dbPath: db)
        let result: IndexEmbeddings.Result
        do {
            result = try IndexEmbeddings.run(database, embedder: embedder, full: full)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: index failed: \(error)\n".utf8))
            throw ExitCode(1)
        }
        if json {
            print(stringifyPretty(indexResultJSON(result)))
        } else {
            print("indexed: \(indexResultSummary(result))")
        }
    }
}

/// `ad-cli sync <source> --db <ADDB>` — crawl one source then index it
/// (CrawlDriver.sync — the native mirror of cli.js sync's crawl+index for one
/// source).
struct SyncCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync",
        abstract: "Crawl one source into an ADDB corpus, then build its embedding index.")

    @Argument(help: "Source to sync (native adapters only).")
    var source: String

    @Option(name: .long, help: "Path to the writable ADDB corpus (created + migrated if missing).")
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
        let embedder = try loadIndexEmbedder(dbPath: db)
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
                        ("index", indexResultJSON(result.index))
                    ])))
        } else {
            print(
                "synced \(source): discovered \(result.crawl.discovered), persisted \(result.crawl.persisted), "
                    + "skipped \(result.crawl.skipped), failed \(result.crawl.failed); "
                    + "index \(indexResultSummary(result.index))")
        }
    }
}

/// `ad-cli sync-all --db <ADDB>` — crawl EVERY native source into the corpus (each
/// source's discover → upsert-roots → crawl, flat or BFS per its syncMode), then build
/// the embedding index once. The native mirror of `bun cli.js sync` over all sources;
/// one source's failure is logged and never aborts the run.
struct SyncAllCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "sync-all",
        abstract: "Crawl every native source into an ADDB corpus, then build the embedding index once.")

    @Option(name: .long, help: "Path to the writable ADDB corpus (created + migrated if missing).")
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

        if !skipIndex {
            let embedder = try loadIndexEmbedder(dbPath: db)
            let indexResult = try driver.index(database, embedder: embedder)
            print("index: \(indexResultSummary(indexResult))")
        }
    }
}

/// `ad-cli snapshot --db <ADDB> --out <dir> --tag <snapshot-YYYYMMDD>` — build
/// the distributable snapshot archive (Snapshot.build; deterministic
/// createdAt/mtimes derive from the tag).
struct SnapshotCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "snapshot",
        abstract: "Build the distributable snapshot archive from an ADDB corpus.")

    @Option(name: .long, help: "Path to the ADDB corpus to snapshot.")
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
