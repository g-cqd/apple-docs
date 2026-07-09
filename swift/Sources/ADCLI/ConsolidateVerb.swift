// `ad-cli consolidate [--dry-run] [--minify]` — repair failed crawl entries and
// re-resolve URLs that became reachable after the original failure (src/cli/
// maintenance.js dispatchConsolidate → src/commands/consolidate.js). Steps: drop
// entries the normalizer now rejects (fragments, dot-ops, `-data.dictionary`
// artifacts) and cross-adapter false positives; re-resolve the remainder via their
// parent page's raw-json references and re-fetch them; delayed-retry transient
// (5xx/429/timeout) failures; optionally minify the raw-json tree. Resumable: re-run
// after interruption to continue from the last checkpoint.
//
// Output mirrors the JS maintenance dispatch: the human line is
// `consolidate: <JSON.stringify(result)>` (the `summary('consolidate')` formatter);
// `--json` is the raw result object, `JSON.stringify(…, null, 2)`-identical —
// `resolvedPaths` appears only under `--dry-run` (the JS `undefined` omission), and
// `bodyIndexed`/`snapshotVerification`/`corpusIntegrity` are the constants the JS CLI
// surface produces (its `indexBody`/`verify` options are not reachable from cli.js).
// The JS logger.info diagnostics stream to stderr as plain lines. Fetch tuning rides
// the JS env knobs: `APPLE_DOCS_RATE` (default 5 req/s — the interactive, non-crawl
// budget), `APPLE_DOCS_BURST` (default max(rate, 2)) and `APPLE_DOCS_CONCURRENCY`
// (default 5), exactly the cli.js ctx the JS consolidate runs under.

import ADBuilder
import ADBuilderPipeline
import ADJSONCore
import ADStorage
import ADWrite
import ArgumentParser
import Foundation

struct ConsolidateCommand: AsyncParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "consolidate",
        abstract: "Repair failed crawl entries and re-resolve URLs that became reachable.")

    @OptionGroup var corpus: CorpusOptions

    @Flag(name: .customLong("dry-run"), help: "Report what would change without persisting.")
    var dryRun = false

    @Flag(name: .long, help: "Trim raw-JSON payloads in place after consolidation.")
    var minify = false

    @Flag(name: .long, help: "Output raw JSON.")
    var json = false

    func run() async throws {
        let db = try openCrawlCorpus(corpus.path)
        let dataDir = (corpus.path as NSString).deletingLastPathComponent
        let environment = ProcessInfo.processInfo.environment
        // cli.js non-crawl ctx: rate = APPLE_DOCS_RATE ?? 5, burst = max(rate, APPLE_DOCS_BURST ?? 2).
        let rate = environment["APPLE_DOCS_RATE"].flatMap(Double.init) ?? 5
        let burst = Swift.max(rate, environment["APPLE_DOCS_BURST"].flatMap(Double.init) ?? 2)
        // consolidate.js: max(1, APPLE_DOCS_CONCURRENCY ?? 5).
        let concurrency = Swift.max(1, environment["APPLE_DOCS_CONCURRENCY"].flatMap(Int.init) ?? 5)
        let context = SourceContext(
            client: URLSessionHTTPClient(), rateLimiter: RateLimiter(rate: rate, burst: burst))
        let driver = ConsolidateDriver(registry: SourceRegistry(SourceRegistry.nativeAdapterTypes))
        let options = ConsolidateDriver.Options(
            dryRun: dryRun, minify: minify, concurrency: concurrency, now: jsIsoNow(),
            pid: Int64(ProcessInfo.processInfo.processIdentifier), log: { MaintenanceVerb.logInfo($0) })

        let result: ConsolidateDriver.Result
        do {
            result = try await MaintenanceVerb.runAsync {
                try await driver.run(db, dataDir: dataDir, context: context, options: options)
            }
        } catch let code as ExitCode {
            throw code
        } catch {
            FileHandle.standardError.write(Data("ad-cli: consolidate failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        let value = consolidateJSON(result)
        print(json ? stringifyPretty(value) : "consolidate: \(stringifyCompact(value))")
    }

    /// The JS result object, key order pinned (JSON.stringify drops the non-dry-run
    /// `resolvedPaths: undefined`; the always-null verify reports stay).
    private func consolidateJSON(_ result: ConsolidateDriver.Result) -> JSONValue {
        var pairs: [(String, JSONValue)] = [
            ("analyzed", .int(Int64(result.analyzed))),
            ("cleaned", .int(Int64(result.cleaned))),
            ("crossAdapter", .int(Int64(result.crossAdapter))),
            ("resolved", .int(Int64(result.resolved))),
            ("retried", .int(Int64(result.retried))),
            ("retriedOk", .int(Int64(result.retriedOk))),
            ("transientRecovered", .int(Int64(result.transientRecovered))),
            ("genuine", .int(Int64(result.genuine))),
            ("minified", .int(Int64(result.minified))),
            ("minifySaved", .int(Int64(result.minifySaved))),
            ("bodyIndexed", .int(0)),
            ("snapshotVerification", .null),
            ("corpusIntegrity", .null)
        ]
        if result.dryRun {
            pairs.append(("resolvedPaths", .array(result.resolvedPaths.map(resolvedPathValue))))
        }
        pairs.append(("dryRun", .bool(result.dryRun)))
        return .obj(pairs)
    }

    /// One dry-run `resolvedPaths` entry — `{ oldPath, newPath, root, title }`, the
    /// `title` key omitted when the reference carried none (the JS `undefined`).
    private func resolvedPathValue(_ entry: Consolidate.ResolvedPath) -> JSONValue {
        var pairs: [(String, JSONValue)] = [
            ("oldPath", .string(entry.oldPath)),
            ("newPath", .string(entry.newPath)),
            ("root", .string(entry.root))
        ]
        if let title = entry.title { pairs.append(("title", .string(title))) }
        return .obj(pairs)
    }
}
