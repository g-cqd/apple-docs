// `consolidate` core gate (Consolidate — the consolidate.js steps 1-2 +
// storage-helpers.js + retry-transient.js classifier ports): invalid-path and
// transient-error classification (JS strings AND the native crawl's error
// spellings), the clean + parent-reference-resolve analysis (with the dry-run
// no-mutation guarantee), the JS-stringify-identical retry checkpoint, and the
// `--minify` directory pass.

import ADStorage
import Foundation
import Testing

@testable import ADWrite

@Suite("Consolidate — the failed-crawl doctor's sync core")
struct ConsolidateTests {
    private let now = "2026-07-09T00:00:00.000Z"

    private func seedFailed(
        _ corpus: MaintenanceCorpus, path: String, rootSlug: String, error: String = "Not found"
    ) throws {
        try CrawlPersist.seedCrawlIfNew(corpus.db, path: path, rootSlug: rootSlug, depth: 1)
        try CrawlPersist.setCrawlState(
            corpus.db, path: path, status: "failed", rootSlug: rootSlug, depth: 1, error: error)
    }

    // MARK: - classification

    @Test("isInvalidFailedPath rejects fragments, dot-ops, artifacts, and renorm mismatches")
    func invalidPaths() {
        #expect(Consolidate.isInvalidFailedPath("documentation/swiftui#section"))
        #expect(Consolidate.isInvalidFailedPath("swiftui/view#discussion"))
        #expect(Consolidate.isInvalidFailedPath("swift/int/.==(_:_:)"))  // dot-operator segment
        #expect(
            Consolidate.isInvalidFailedPath(
                "enterpriseprogramapi/profile/relationships-data.dictionary/links"))
        #expect(Consolidate.isInvalidFailedPath("SwiftUI/View"))  // renorm lowercases
        #expect(Consolidate.isInvalidFailedPath("documentation/swiftui"))  // renorm strips prefix
        #expect(!Consolidate.isInvalidFailedPath("swiftui/view"))
        #expect(!Consolidate.isInvalidFailedPath("os/oslogfloatformatting/hex(explicitpositivesign:uppercase:)"))
    }

    @Test("isTransientError matches the JS transient strings and rejects permanents")
    func transientJsStrings() {
        #expect(Consolidate.isTransientError("HTTP 500 fetching https://x.json"))
        #expect(Consolidate.isTransientError("HTTP 503 fetching https://x.json"))
        #expect(Consolidate.isTransientError("HTTP 429 fetching https://x.json"))
        #expect(Consolidate.isTransientError("HTTP 408 fetching https://x.json"))
        #expect(Consolidate.isTransientError("fetch failed"))
        #expect(Consolidate.isTransientError("The request timed out"))
        #expect(Consolidate.isTransientError("connect ECONNRESET 17.253.1.1:443"))
        #expect(!Consolidate.isTransientError("Not found"))
        #expect(!Consolidate.isTransientError("HTTP 403 fetching https://x.json"))
        #expect(!Consolidate.isTransientError("HTTP 404 fetching https://x.json"))
        #expect(!Consolidate.isTransientError("HTTP 400 fetching https://x.json"))
        #expect(!Consolidate.isTransientError(nil))
    }

    @Test("isTransientError classifies the native crawl's error spellings")
    func transientNativeStrings() {
        #expect(Consolidate.isTransientError(#"httpStatus(503, "https://developer.apple.com/x.json")"#))
        #expect(Consolidate.isTransientError(#"httpStatus(429, "https://x")"#))
        #expect(Consolidate.isTransientError("transport(ADBuilder.HTTPClientError.deadlineExceeded)"))
        #expect(
            Consolidate.isTransientError(
                #"transport(ADBuilder.HTTPClientError.connectionFailed("Could not connect"))"#))
        #expect(Consolidate.isTransientError(#"transport(ADBuilder.HTTPClientError.tls("handshake"))"#))
        #expect(!Consolidate.isTransientError(#"httpStatus(404, "https://x")"#))
        #expect(!Consolidate.isTransientError(#"httpStatus(403, "https://x")"#))
        #expect(
            !Consolidate.isTransientError(
                #"unexpectedPayload("apple-docc: unparseable JSON for swiftui/view")"#))
    }

    // MARK: - analyze (steps 1-2)

    @Test("analyze returns zeros for an empty corpus")
    func emptyCorpus() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-empty")
        defer { corpus.destroy() }
        let analysis = try Consolidate.analyze(corpus.db, dataDir: corpus.dataDir, dryRun: true)
        #expect(
            analysis
                == Consolidate.Analysis(
                    analyzed: 0, cleaned: 0, crossAdapter: 0, resolved: 0, resolvedPaths: []))
    }

    @Test("analyze cleans invalid paths and cross-adapter false positives")
    func cleansInvalidAndCrossAdapter() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-clean")
        defer { corpus.destroy() }
        _ = try corpus.addRoot(slug: "swiftui", sourceType: "apple-docc", now: now)
        // swift-compiler is served by the swift-docc adapter — the catalog 404 is a false positive.
        _ = try corpus.addRoot(slug: "swift-compiler", sourceType: "swift-docc", now: now)
        try seedFailed(corpus, path: "documentation/swiftui#section", rootSlug: "swiftui")
        try seedFailed(corpus, path: "swift-compiler", rootSlug: "swift-compiler")
        try seedFailed(
            corpus, path: "enterpriseprogramapi/profile/relationships-data.dictionary/links",
            rootSlug: "enterpriseprogramapi")
        try seedFailed(corpus, path: "swiftui/view", rootSlug: "swiftui")  // genuine — kept

        let analysis = try Consolidate.analyze(corpus.db, dataDir: corpus.dataDir, dryRun: false)
        #expect(analysis.analyzed == 4)
        #expect(analysis.cleaned == 2)  // the fragment + the -data.dictionary artifact
        #expect(analysis.crossAdapter == 1)
        #expect(analysis.resolved == 0)
        #expect(try Consolidate.genuineFailedCount(corpus.db) == 1)
        #expect(try Consolidate.failedRows(corpus.db).map(\.path) == ["swiftui/view"])
    }

    @Test("dry-run analysis reports the same counts but deletes nothing")
    func dryRunKeepsRows() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-dry")
        defer { corpus.destroy() }
        _ = try corpus.addRoot(slug: "swiftui", sourceType: "apple-docc", now: now)
        try seedFailed(corpus, path: "documentation/swiftui#section", rootSlug: "swiftui")

        let analysis = try Consolidate.analyze(corpus.db, dataDir: corpus.dataDir, dryRun: true)
        #expect(analysis.analyzed == 1)
        #expect(analysis.cleaned == 1)
        #expect(try Consolidate.genuineFailedCount(corpus.db) == 1)  // still there
    }

    @Test("analyze resolves a failed path via the parent page's references")
    func resolvesViaParent() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-resolve")
        defer { corpus.destroy() }
        _ = try corpus.addRoot(slug: "swiftui", sourceType: "apple-docc", now: now)
        try seedFailed(corpus, path: "swiftui/view/composer", rootSlug: "swiftui")
        try seedFailed(corpus, path: "swiftui/rootless", rootSlug: "swiftui")  // no parent file
        try seedFailed(corpus, path: "toplevel", rootSlug: "toplevel")  // < 2 segments — skipped
        let parent = """
            {"references":{
              "doc://com.apple.SwiftUI/documentation/SwiftUI/View/composer":
                {"url":"/documentation/swiftui/view/composer-6h3g5","title":"composer"},
              "doc://com.apple.SwiftUI/documentation/SwiftUI/View/other":
                {"url":"/documentation/swiftui/view/other"}
            }}
            """
        try writeFixture(corpus, at: "raw-json/swiftui/view.json", parent)

        let analysis = try Consolidate.analyze(corpus.db, dataDir: corpus.dataDir, dryRun: false)
        #expect(analysis.resolved == 1)
        #expect(
            analysis.resolvedPaths == [
                Consolidate.ResolvedPath(
                    oldPath: "swiftui/view/composer", newPath: "swiftui/view/composer-6h3g5",
                    root: "swiftui", title: "composer")
            ])
    }

    @Test("a reference whose url normalizes back to the failed path resolves nothing")
    func sameUrlDoesNotResolve() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-same")
        defer { corpus.destroy() }
        _ = try corpus.addRoot(slug: "swiftui", sourceType: "apple-docc", now: now)
        try seedFailed(corpus, path: "swiftui/view/composer", rootSlug: "swiftui")
        let parent = """
            {"references":{"swiftui/view/composer":{"url":"/documentation/swiftui/view/composer"}}}
            """
        try writeFixture(corpus, at: "raw-json/swiftui/view.json", parent)
        let analysis = try Consolidate.analyze(corpus.db, dataDir: corpus.dataDir, dryRun: false)
        #expect(analysis.resolved == 0)
        #expect(analysis.resolvedPaths.isEmpty)
    }

    // MARK: - checkpoint

    @Test("the retry checkpoint round-trips and stores JS-stringify-identical JSON")
    func checkpointRoundTrip() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-checkpoint")
        defer { corpus.destroy() }
        let checkpoint = Consolidate.Checkpoint(
            analyzed: 3, cleaned: 1, resolved: 2, retried: 1, retriedOk: 1, nextIndex: 1,
            resolvedPaths: [
                Consolidate.ResolvedPath(oldPath: "a/b", newPath: "a/c", root: "a", title: "T \"q\""),
                Consolidate.ResolvedPath(oldPath: "a/d", newPath: "a/e", root: "a", title: nil)
            ])
        try Consolidate.writeCheckpoint(corpus.db, checkpoint, now: now)

        // The stored value is the JS `JSON.stringify(value)` byte-for-byte (insertion
        // key order; the nil title omits its key like the JS `undefined`).
        let stored = try corpus.db.get(
            "SELECT value FROM sync_checkpoint WHERE key = $key",
            ["key": .text(Consolidate.retryCheckpointKey)])?
            .text("value")
        let expected =
            "{\"analyzed\":3,\"cleaned\":1,\"resolved\":2,\"retried\":1,\"retriedOk\":1,\"nextIndex\":1,"
            + "\"resolvedPaths\":[{\"oldPath\":\"a/b\",\"newPath\":\"a/c\",\"root\":\"a\",\"title\":\"T \\\"q\\\"\"},"
            + "{\"oldPath\":\"a/d\",\"newPath\":\"a/e\",\"root\":\"a\"}]}"
        #expect(stored == expected)

        #expect(Consolidate.readCheckpoint(corpus.db) == checkpoint)
        try Consolidate.clearCheckpoint(corpus.db)
        #expect(Consolidate.readCheckpoint(corpus.db) == nil)
    }

    // MARK: - activity bracket

    @Test("setActivity writes the singleton row and clearActivity removes it")
    func activityBracket() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-activity")
        defer { corpus.destroy() }
        try Consolidate.setActivity(corpus.db, action: "consolidate", now: now, pid: 4242)
        let row = try corpus.db.get("SELECT action, pid, roots FROM activity WHERE id = 1")
        #expect(row?.text("action") == "consolidate")
        #expect(row?.int("pid") == 4242)
        #expect(row?.text("roots") == nil)
        try Consolidate.clearActivity(corpus.db)
        #expect(try corpus.count("SELECT COUNT(*) AS c FROM activity") == 0)
    }

    // MARK: - minify

    @Test("minifyDir minifies pretty JSON to stableStringify form and skips the rest")
    func minifyDirectory() throws {
        let corpus = try MaintenanceCorpus.make("consolidate-minify")
        defer { corpus.destroy() }
        let pretty = """
            {
              "key": "value",
              "nested": {
                "b": 2,
                "a": 1
              }
            }
            """
        try writeFixture(corpus, at: "raw-json/pretty.json", pretty)
        try writeFixture(corpus, at: "raw-json/nested/deep.json", "{\n  \"z\": true\n}")
        try writeFixture(corpus, at: "raw-json/minified.json", "{\"already\":1}")  // no newline — skipped
        try writeFixture(corpus, at: "raw-json/not-json.json", "# markdown\ntext")  // wrong first byte
        try writeFixture(corpus, at: "raw-json/broken.json", "{\n  \"unterminated\": ")  // warn + skip

        let result = Consolidate.minifyDir(corpus.dataDir + "/raw-json")
        #expect(result.count == 2)
        #expect(result.saved > 0)
        // stableStringify: compact with recursively SORTED keys.
        let minified = try String(
            contentsOfFile: corpus.dataDir + "/raw-json/pretty.json", encoding: .utf8)
        #expect(minified == "{\"key\":\"value\",\"nested\":{\"a\":1,\"b\":2}}")
        let untouched = try String(
            contentsOfFile: corpus.dataDir + "/raw-json/minified.json", encoding: .utf8)
        #expect(untouched == "{\"already\":1}")
    }

    // MARK: - helpers

    private func writeFixture(_ corpus: MaintenanceCorpus, at relative: String, _ text: String) throws {
        let url = corpus.dir.appendingPathComponent(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
}
