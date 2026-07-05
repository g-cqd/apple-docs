// Hidden one-time-migration verb:
//
//   ad-cli _repair-page-root-ids <db>
//
// RFC 0007 §11 finding #2: `CrawlDriver.crawlFrontier`'s `getPendingCrawlAny` used to pull EVERY
// `pending` `crawl_state` row with no root/source filter, so a `pending` backlog left over from an
// earlier, DIFFERENT source's crawl (this corpus: an interrupted apple-docc run) got vacuumed up by
// whichever `.crawl`-mode source ran next (here: hig) and persisted via that caller's OWN
// `rootIds[f.rootSlug] ?? rootId` fallback — mis-stamping `pages.root_id` with the WRONG source's
// default root on that page's first-ever persist. `getPendingCrawlAny` is now scoped to the calling
// crawl's own root set (fixing this going FORWARD — see `CrawlPersist.getPendingCrawlAny`), but a
// corpus crawled by the buggy binary already has the wrong `pages.root_id` baked in. This verb repairs
// an already-corrupted corpus by thinly wrapping `ADWrite.RepairPageRootIds.run` (the actual
// read/resolve/write logic — see that file's header for the full derivation of the join keys and the
// batching strategy) and then `backfillAllRootPageCounts` (reused, not duplicated), since repairing
// `root_id` moves pages between roots' counts. Not a shipped verb — a narrow migration for corpora
// crawled by the buggy binary (matches the `_addb-*-spike` / `_backfill-page-count` convention).

import ADDB
import ADWrite
import ArgumentParser
import Foundation

struct RepairPageRootIdsSpikeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_repair-page-root-ids",
        abstract:
            "One-time re-derivation of pages.root_id from crawl_state/documents ground truth (migration spike).",
        shouldDisplay: false)

    @Argument(help: "Path to the corpus database to repair (opened writable, in place).")
    var db: String

    @Option(name: .long, help: "Active pages repaired per UPDATE statement (full-scan amortization batch).")
    var batchSize: Int = 1000

    func run() throws {
        let database: Database
        do {
            database = try Database.open(at: db, options: DatabaseOptions(readOnly: false, createIfMissing: false))
        } catch {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(db): \(error)\n".utf8))
            throw ExitCode(1)
        }

        let result: RepairPageRootIds.Result
        do {
            result = try RepairPageRootIds.run(database, batchSize: batchSize)
        } catch {
            FileHandle.standardError.write(Data("ad-cli: repair failed: \(error)\n".utf8))
            throw ExitCode(1)
        }

        if !result.unresolvedSamples.isEmpty {
            let joined = result.unresolvedSamples.joined(separator: "\n  ")
            FileHandle.standardError.write(
                Data("ad-cli: \(result.unresolved) page(s) unresolved, e.g.:\n  \(joined)\n".utf8))
        }
        print(
            "repaired root_id for \(result.changed)/\(result.examined) active pages "
                + "(\(result.alreadyCorrect) already correct, \(result.unresolved) unresolved)")

        let (touched, total) = try backfillAllRootPageCounts(database)
        print("backfilled page_count for \(touched)/\(total) roots")
    }
}
