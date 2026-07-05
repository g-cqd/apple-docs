// Hidden one-time-migration verb:
//
//   ad-cli _backfill-page-count <db>
//
// `roots.page_count` was never maintained by the crawl-persist write path (it stayed at its
// schema `DEFAULT 0` forever — CrawlDriver now calls `CrawlPersist.refreshRootPageCount` after
// each crawl, fixing it going FORWARD), so any corpus crawled before that fix has every root
// stuck at 0, which breaks `list_frameworks`/`browse`/`/api/filters` against real data. This
// recomputes `page_count` for every existing root once, in place. Not a shipped verb — a narrow
// migration for corpora crawled by an older binary (matches the `_addb-*-spike` convention).

import ADDB
import ADWrite
import ArgumentParser
import Foundation

struct BackfillPageCountSpikeCommand: ParsableCommand {
    static let configuration = CommandConfiguration(
        commandName: "_backfill-page-count",
        abstract: "One-time recompute of roots.page_count for an existing corpus (migration spike).",
        shouldDisplay: false)

    @Argument(help: "Path to the corpus database to backfill (opened writable, in place).")
    var db: String

    func run() throws {
        let database: Database
        do {
            database = try Database.open(at: db, options: DatabaseOptions(readOnly: false, createIfMissing: false))
        } catch {
            FileHandle.standardError.write(Data("ad-cli: cannot open \(db): \(error)\n".utf8))
            throw ExitCode(1)
        }
        let (touched, total) = try backfillAllRootPageCounts(database)
        print("backfilled page_count for \(touched)/\(total) roots")
    }
}

/// Recomputes `roots.page_count` for EVERY root in `database`, in place (`CrawlPersist
/// .refreshRootPageCount`'s full recount, applied corpus-wide). The shared core of `ad-cli
/// _backfill-page-count` and `ad-cli _repair-page-root-ids` — the latter MUST re-run this after
/// re-deriving `pages.root_id`, since moving a page from one root to another changes BOTH roots'
/// counts, and a full recompute is simplest/safest (matches the existing verb's own already-full-corpus
/// scan rather than tracking which roots were "affected"). A root whose refresh throws is logged to
/// stderr and skipped, not fatal — one bad root row never blocks the rest.
///
/// - Returns: `(touched, total)` — how many of the corpus's roots were successfully recomputed, out of
///   how many exist.
func backfillAllRootPageCounts(_ database: Database) throws -> (touched: Int, total: Int) {
    let rows: [SQLRow]
    do {
        rows = try database.prepare("SELECT id, slug FROM roots ORDER BY id").all([:])
    } catch {
        FileHandle.standardError.write(Data("ad-cli: cannot read roots: \(error)\n".utf8))
        throw ExitCode(1)
    }

    var touched = 0
    for row in rows {
        guard case .integer(let id)? = row["id"] else { continue }
        do {
            try CrawlPersist.refreshRootPageCount(database, rootId: id)
            touched += 1
        } catch {
            let slug: String = if case .text(let s)? = row["slug"] { s } else { "?" }
            FileHandle.standardError.write(Data("ad-cli: root \(slug) (#\(id)) failed: \(error)\n".utf8))
        }
    }
    return (touched, rows.count)
}
