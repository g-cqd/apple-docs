// `ad-cli crawl <source>` — the native crawl WRITER verb. Mirrors the crawl phase of
// the Bun `cli.js sync`: for ONE source, discover → fetch → normalize → persist into a
// writable SQLite corpus (the JS `bun:sqlite` format — the storage pivot), driven by
// `ADBuilderPipeline.CrawlDriver` over the ADWrite sinks (`CrawlPersist`).
//
// Scope (first slice): the natively-ported adapters — swift-org / swift-book /
// swift-evolution. The remaining JS-only adapters, the post-crawl `IndexEmbeddings`
// pass (a future `--index` / `sync` verb), and the `Snapshot` build are follow-ups
// (RFC 0007 P7 / the G-track notes). `CrawlDriver` already implements the incremental
// `check`→skip and the bounded-concurrency fetch, so this verb is pure wiring.

import ADBuilder
import ADBuilderPipeline
import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

/// Upsert every discovered root, returning the default (first) rootId and the `slug -> rootId` map the
/// crawl driver attributes pages by. A multi-root flat source (swift-docc's three archives) then
/// persists each page under its own root; a single-root source yields a one-entry map + that root as
/// the default. Assumes `roots` is non-empty (the verbs guard that first, for a clear error message).
func upsertCrawlRoots(
    _ database: SQLiteWriteConnection, _ roots: [DiscoveredRoot], now: String
) throws -> (defaultRootId: Int64, rootIds: [String: Int64]) {
    var rootIds: [String: Int64] = [:]
    var defaultRootId: Int64 = 0
    for (index, root) in roots.enumerated() {
        let id = try CrawlPersist.upsertRoot(
            database, slug: root.slug, displayName: root.displayName, kind: root.kind,
            source: root.source, seedPath: root.seedPath, sourceType: root.sourceType, now: now)
        rootIds[root.slug] = id
        if index == 0 { defaultRootId = id }
    }
    return (defaultRootId, rootIds)
}

struct CrawlCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "crawl",
        abstract:
            "Crawl one documentation source into a writable SQLite corpus (mirrors cli.js sync's crawl phase).")

    @Argument(help: "Source to crawl (a natively-ported adapter).")
    var source: String

    @Option(
        name: .long, help: "Path to the writable SQLite corpus (created + migrated to the latest schema if missing).")
    var db: String

    @Option(name: .long, help: "Max concurrent fetch+normalize tasks in flight (default 8).")
    var concurrency: Int = 8

    @Flag(
        name: .long,
        help: ArgumentHelp(
            "Force a full re-fetch: reset the source's processed frontier (and skip stored HTTP "
                + "validators) so every page is fetched again — re-materializing raw-json for all of them."))
    var full = false

    @Flag(name: .long, help: "Emit the crawl stats as JSON instead of the human summary.")
    var json = false

    // `now` is bound to `first_seen`/`last_seen` (CrawlPersist). The JS writer binds
    // `new Date().toISOString()` (ISO-8601 UTC WITH milliseconds), so the native `now`
    // uses `.withFractionalSeconds` for cross-writer timestamp parity. `ISO8601DateFormatter`
    // is thread-safe for `string(from:)` once configured but isn't `Sendable` —
    // `nonisolated(unsafe)` is the codebase convention (cf. `IntentDetector`'s `Regex`).
    nonisolated(unsafe) private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    func validate() throws {
        guard !db.isEmpty else { throw ValidationError("--db must not be empty") }
        guard concurrency >= 1 else { throw ValidationError("--concurrency must be >= 1") }
    }

    func run() async throws {
        // The registry of natively-ported adapters (the shared list). `adapter(for:)`
        // throws a clear error for the JS-only sources (those still crawl via Bun `sync`).
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

        // Open (creating if needed) the SQLite corpus and bring it to the latest apple-docs schema.
        let database: SQLiteWriteConnection
        do {
            database = try SQLiteWriteConnection(path: db)
            _ = try migrateSchema(database)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: cannot open/migrate \(db): \(error)\n".utf8))
            throw ExitCode(1)
        }

        let now = Self.iso8601.string(from: Date())
        let context = SourceContext(client: URLSessionHTTPClient(), rateLimiter: RateLimiter())

        let stats: CrawlDriver.Stats
        do {
            // Establish the source's root from discovery (the JS source of truth for slug/kind),
            // then drive the crawl against it. CrawlDriver re-discovers the page keys internally
            // with its own fresh adapter instance, so no adapter state crosses between the two.
            let discovery = try await adapter.discover(context)
            guard !discovery.roots.isEmpty else {
                FileHandle.standardError.write(Data("ad-cli: source '\(source)' discovered no root\n".utf8))
                throw ExitCode(1)
            }
            let (rootId, rootIds) = try upsertCrawlRoots(database, discovery.roots, now: now)
            stats = try await CrawlDriver(registry: registry)
                .crawl(
                    sourceType: source, into: database, rootId: rootId, rootIds: rootIds,
                    context: context, now: now, maxConcurrency: concurrency,
                    dataDir: (db as NSString).deletingLastPathComponent, force: full)
        } catch let code as ExitCode {
            throw code
        } catch {
            FileHandle.standardError.write(Data("ad-cli: crawl \(source) failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        if json {
            print(
                stringifyPretty(
                    .obj([
                        ("source", .string(source)),
                        ("discovered", .int(Int64(stats.discovered))),
                        ("persisted", .int(Int64(stats.persisted))),
                        ("skipped", .int(Int64(stats.skipped))),
                        ("failed", .int(Int64(stats.failed)))
                    ])))
        } else {
            print(
                "crawled \(source): discovered \(stats.discovered), persisted \(stats.persisted), "
                    + "skipped \(stats.skipped), failed \(stats.failed)")
        }
    }
}
