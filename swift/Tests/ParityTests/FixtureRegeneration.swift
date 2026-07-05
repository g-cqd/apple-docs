// Regenerates the committed Tier 1 fixture corpus (`Fixtures/js-corpus`, `Fixtures/swift-corpus`)
// from a LIVE, scoped crawl of the real developer.apple.com corpus. Disabled by default — this
// needs network access plus both `bun` and a release `ad-cli` build — and is NOT a gate; the
// frozen, committed fixture files are what `CLIParityTests` compares against, exactly like
// ADWriteTests/SchemaParityTests.swift's `captureReferenceFixture` is a disabled-by-default
// regeneration tool for ITS committed fixture, not part of that gate either. Run explicitly with
// `AD_CAPTURE_PARITY_FIXTURE=1` when the chosen framework subset needs to change (e.g. one of the
// three frameworks below grows past "tens of pages" and stops being cheap/fast/deterministic).
//
// Recipe (exactly what this test automates):
//
//   1. `bun cli.js sync --full` against a fresh, scratch `APPLE_DOCS_HOME`, with:
//        - `<home>/scope.json` = `{"version":1,"sources":["apple-docc"],
//          "appleDoccFrameworks":["adsupport","apptrackingtransparency","signinwithapple"],
//          "keepFonts":false,"keepSymbols":false}` — the shape `src/lib/scope.js` documents.
//          Narrows the crawl to exactly these 3 real, tiny (5 + 10 + 13 = 28 pages total)
//          frameworks instead of the full ~340K-page corpus (RFC 0007 §12: "a handful of real
//          frameworks... for speed and determinism").
//        - `APPLE_DOCS_NATIVE=off` (mandatory — see CLIParityTests.swift's header: without it
//          cli.js silently delegates to the native binary by default).
//        - `APPLE_DOCS_SKIP_RESOURCES=1` — skip fonts/SF Symbols entirely; belt-and-suspenders
//          alongside the scope's own `keepFonts`/`keepSymbols: false` (src/commands/sync/phases.js
//          honors both independently).
//      This produces a real, JS-crawled SQLite `apple-docs.db` — the only way left to get a
//      genuinely `bun:sqlite`-openable corpus at all (the live production db was PROMOTED to ADDB
//      format per this RFC's own status line, so it can no longer serve as a JS-side fixture).
//
//   2. `sqlite3 apple-docs.db "PRAGMA journal_mode=DELETE; VACUUM;"` — checkpoints the WAL and
//      compacts to ONE self-contained file (no `-wal`/`-shm` sidecars to commit).
//
//   3. Delete the crawl's `raw-json/`/`markdown/` directories before committing anything. This is
//      NOT just repo hygiene: `markdown/` is JS's on-demand-render CACHE (`lookup.js` writes a
//      rendered `.md` file back to disk on a cache miss), and `ad-cli read` has no equivalent — it
//      always renders fresh from DB sections. Committing a pre-populated `markdown/` cache would
//      permanently bake in a spurious divergence (`cli.js read` hitting the stale cached file while
//      `ad-cli read` always renders on demand) even though both engines render byte-IDENTICALLY
//      once forced onto the same on-demand path — confirmed concretely while building this harness:
//      an early manual run against a fixture directory that still had a populated `markdown/`
//      showed real-looking differences (missing framework-qualified relative links, missing
//      relationship hyperlinks, a different page count at a fixed `--max-chars`); every one of them
//      vanished once the directory was stripped and the read re-run against a pristine copy.
//      `status`'s `rawJson`/`markdown` DirStats fields are excluded from comparison regardless of
//      this (`ParityCase.statusVolatilePaths`) — see that constant's own doc comment for why.
//
//   4. `ad-cli import <sqlite-path> --db <addb-path>` — the SAME tool that promoted the real
//      production corpus (per this RFC's status line), building the Swift-side ADDB fixture by
//      DERIVING it from the exact JS-crawled SQLite file. Both committed fixtures therefore
//      represent byte-identical underlying corpus content — "a single shared corpus... committed as
//      two fixture files" (RFC 0007 §12's preferred shape) — rather than two independently-crawled
//      corpora that could drift apart on the SEPARATE crawl-level parity concerns RFC 0007 §11
//      documents (findings #2/#6, "JS↔Swift corpus parity" — a different gate from this Tier's
//      CLI-dispatch concern). Two independent crawls were considered and deliberately rejected for
//      exactly that reason: Tier 1 exists to test the CLI dispatch/formatting layer given the SAME
//      data, not to re-litigate crawler parity.
//
// Framework choice: adsupport/apptrackingtransparency/signinwithapple were picked by querying the
// real corpus (`ad-cli frameworks --json --db ~/.apple-docs/apple-docs.db`, sorted by `pageCount`)
// for real, tiny, apple-docc-sourced frameworks — `adsupport` is the exact size class this RFC's
// own task description named ("accessoryaccess/adsupport-sized, tens not thousands of pages").

import Foundation
import Testing

@Suite("Tier 1 parity fixture regeneration (maintenance tool, not a gate)")
struct FixtureRegenerationTests {
    private static let scopedFrameworks = ["adsupport", "apptrackingtransparency", "signinwithapple"]

    @Test(
        "regenerate the committed js-corpus/swift-corpus fixtures from a live scoped crawl",
        .enabled(
            if: ParityEnvironment.isAvailable
                && ProcessInfo.processInfo.environment["AD_CAPTURE_PARITY_FIXTURE"] != nil,
            Comment(
                rawValue: "set AD_CAPTURE_PARITY_FIXTURE=1 (with bun + a release ad-cli build + "
                    + "network access) to regenerate — needs a live crawl, so it is never run as "
                    + "part of the gate")))
    func regenerateFixture() async throws {
        let bun = try #require(ParityEnvironment.bunPath)
        let appleDocsRoot = try #require(ParityEnvironment.appleDocsRoot)
        let adCli = try #require(ParityEnvironment.adCliPath)

        let scratchRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ad-parity-regen-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: scratchRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: scratchRoot) }

        let frameworkList = Self.scopedFrameworks.map { "\"\($0)\"" }.joined(separator: ", ")
        let scopeJSON = """
            {
              "version": 1,
              "sources": ["apple-docc"],
              "appleDoccFrameworks": [\(frameworkList)],
              "keepFonts": false,
              "keepSymbols": false
            }
            """
        try scopeJSON.write(
            to: scratchRoot.appendingPathComponent("scope.json"), atomically: true, encoding: .utf8)

        let sync = try ParityProcess.run(
            executable: bun, arguments: ["cli.js", "sync", "--full"],
            environment: [
                "APPLE_DOCS_HOME": scratchRoot.path, "APPLE_DOCS_NATIVE": "off",
                "APPLE_DOCS_SKIP_RESOURCES": "1", "APPLE_DOCS_SKIP_UPDATE_CHECK": "1"
            ],
            currentDirectory: appleDocsRoot)
        #expect(sync.exitCode == 0, "scoped sync failed: \(sync.stderr)")

        // Compact to one self-contained file, and drop the render caches (see this file's header).
        let jsDbURL = scratchRoot.appendingPathComponent("apple-docs.db")
        try runSQLite3(dbPath: jsDbURL.path, sql: "PRAGMA journal_mode=DELETE; VACUUM;")
        try? FileManager.default.removeItem(at: scratchRoot.appendingPathComponent("raw-json"))
        try? FileManager.default.removeItem(at: scratchRoot.appendingPathComponent("markdown"))

        let jsFixtureDir = ParityEnvironment.fixturesRoot.appendingPathComponent("js-corpus")
        let swiftFixtureDir = ParityEnvironment.fixturesRoot.appendingPathComponent("swift-corpus")
        try FileManager.default.createDirectory(at: jsFixtureDir, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: swiftFixtureDir, withIntermediateDirectories: true)

        let jsFixtureDb = jsFixtureDir.appendingPathComponent("apple-docs.db")
        try? FileManager.default.removeItem(at: jsFixtureDb)
        try FileManager.default.copyItem(at: jsDbURL, to: jsFixtureDb)
        try scopeJSON.write(
            to: jsFixtureDir.appendingPathComponent("scope.json"), atomically: true, encoding: .utf8)

        let swiftFixtureDb = swiftFixtureDir.appendingPathComponent("apple-docs.db")
        try? FileManager.default.removeItem(at: swiftFixtureDb)
        let importResult = try ParityProcess.run(
            executable: adCli, arguments: ["import", jsFixtureDb.path, "--db", swiftFixtureDb.path],
            environment: [:], currentDirectory: appleDocsRoot)
        #expect(importResult.exitCode == 0, "ad-cli import failed: \(importResult.stderr)")

        print("regenerated fixtures under \(ParityEnvironment.fixturesRoot.path)")
    }

    /// Shells to the system `sqlite3` (ships with macOS at a fixed path) to checkpoint + compact
    /// the freshly-crawled db before it's committed. A dev-only maintenance step, so the hardcoded
    /// path is acceptable — unlike `ParityEnvironment.locateBun()`, this never runs as part of the
    /// gate.
    private func runSQLite3(dbPath: String, sql: String) throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        process.arguments = [dbPath, sql]
        try process.run()
        process.waitUntilExit()
    }
}
