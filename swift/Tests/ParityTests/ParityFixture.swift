// A per-test-case, throwaway copy of the committed fixture corpus (`Fixtures/js-corpus`,
// `Fixtures/swift-corpus`). Every parity case copies fresh rather than pointing both engines at the
// committed files directly, for two independent reasons:
//
//   1. Never mutate the committed fixtures. Opening a SQLite db (even read-only) can leave `-wal`/
//      `-shm` sidecars, and opening an ADDB corpus leaves a `.db-lock` file (both observed while
//      building this harness) — neither engine's read path should be trusted not to touch the
//      file it opens, and the committed copies must stay byte-stable across N test runs.
//   2. JS's `read`/`search --read` verbs have a REAL side effect, not just an incidental lock file:
//      `lookup.js` writes a rendered-markdown cache back to `<dataDir>/markdown/<path>.md` on a
//      cache miss (`if (fallback && content && !opts.noCache) { ... }`). A second `read` of the SAME
//      path in the SAME home directory then hits that cache instead of re-rendering from DB
//      sections — a DIFFERENT code path than the one this harness wants to exercise (the one
//      `ad-cli read` always takes, since it has no on-disk render cache at all). Discovered
//      concretely while building this harness: an early draft that reused one fixture directory
//      across manual `read` invocations showed real-looking content differences (missing framework
//      prefixes on relative links, missing relationship hyperlinks, a different page count at a
//      fixed `--max-chars`) that reproduced ONLY because a stale cached `.md` file was already on
//      disk from a prior invocation — they vanished entirely once each invocation started from a
//      pristine copy. Fresh-copy-per-case is what makes the comparison mean anything for `read`.
//
// This is also why the committed fixture carries NO `raw-json/`/`markdown/` directories at all
// (see FixtureRegeneration.swift's header): committing JS's populated markdown cache would bake
// exactly this "JS reads a cache Swift has no equivalent for" divergence into the gate permanently.

import Foundation

/// Fresh, isolated copies of both engines' fixture corpus for one test case. `cleanUp()` removes
/// the whole scratch directory; callers `defer` it immediately after `makeFresh()` succeeds.
struct ParityFixture {
    /// The JS `APPLE_DOCS_HOME` — a directory containing `apple-docs.db` (SQLite), exactly the
    /// shape `cli.js` expects (it always resolves `join(dataDir, 'apple-docs.db')`).
    let jsHomeDirectory: String
    /// The Swift `--db` path — an ADDB-format `apple-docs.db` imported (once, at fixture-generation
    /// time — see FixtureRegeneration.swift) from the exact same JS-crawled SQLite file, so both
    /// fixtures represent the identical underlying corpus content.
    let swiftDatabasePath: String

    private let scratchRoot: URL

    static func makeFresh() throws -> ParityFixture {
        let scratchRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ad-parity-\(UUID().uuidString)")
        let jsHome = scratchRoot.appendingPathComponent("js-home")
        let swiftHome = scratchRoot.appendingPathComponent("swift-home")
        try FileManager.default.createDirectory(at: jsHome, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: swiftHome, withIntermediateDirectories: true)

        let jsSource = ParityEnvironment.fixturesRoot.appendingPathComponent("js-corpus/apple-docs.db")
        let swiftSource = ParityEnvironment.fixturesRoot.appendingPathComponent("swift-corpus/apple-docs.db")
        let jsDestination = jsHome.appendingPathComponent("apple-docs.db")
        let swiftDestination = swiftHome.appendingPathComponent("apple-docs.db")
        try FileManager.default.copyItem(at: jsSource, to: jsDestination)
        try FileManager.default.copyItem(at: swiftSource, to: swiftDestination)

        return ParityFixture(
            jsHomeDirectory: jsHome.path, swiftDatabasePath: swiftDestination.path, scratchRoot: scratchRoot)
    }

    func cleanUp() {
        try? FileManager.default.removeItem(at: scratchRoot)
    }
}
