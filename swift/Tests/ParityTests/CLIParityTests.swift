// The Tier 1 CLI/HTTP verb-for-verb golden parity gate (RFC 0007 §12), realizing §3/§9's
// "verb-for-verb golden parity harness" for the first time as a committed, runnable test. For every
// case in `ParityCases.all`, spawns `bun cli.js <verb> <args>` (`APPLE_DOCS_NATIVE=off` — mandatory:
// without it cli.js silently delegates most verbs, including every read verb, to the native Swift
// binary by default, which would make the "comparison" compare Swift against itself; see RFC 0007
// §11's opening paragraph) and the release-built `ad-cli <verb> <args> --db <fixture>`, each against
// its own fresh copy of the committed fixture corpus (`ParityFixture`), and asserts they agree:
// JSON output intrinsically (`ParityJSON`, ADJSON-backed), human output byte-for-byte.
//
// Skips gracefully — the whole suite, not a crash — when `bun`, `ad-cli`, or `node_modules` aren't
// available (`ParityEnvironment.isAvailable`), matching the schema-parity gate's own
// `SQLiteReferenceExtractor.bunAvailable`-gated precedent (ADWriteTests/SchemaParityTests.swift).

import Foundation
import Testing

@Suite(
    "CLI verb-for-verb golden parity (RFC 0007 §12 Tier 1)",
    .enabled(if: ParityEnvironment.isAvailable, "\(ParityEnvironment.unavailableReason)"))
struct CLIParityTests {
    /// One invocation per `ParityCases.all` entry — every case must pass outright (the harness's
    /// former `withKnownIssue` plumbing is gone: the storage pivot obsoleted both tracked
    /// divergences, see ParityCases.swift's header).
    @Test("cli.js vs ad-cli", arguments: ParityCases.all)
    func verbParity(_ testCase: ParityCase) async throws {
        let bun = try #require(ParityEnvironment.bunPath, "bun unavailable despite suite gating")
        let appleDocsRoot = try #require(
            ParityEnvironment.appleDocsRoot, "apple-docs root unavailable despite suite gating")
        let adCli = try #require(ParityEnvironment.adCliPath, "ad-cli unavailable despite suite gating")

        // Fresh copies per case — never the committed fixture directly. See ParityFixture.swift's
        // header for why this is load-bearing (not just tidiness) for `read`/`search --read`.
        let fixture = try ParityFixture.makeFresh()
        defer { fixture.cleanUp() }

        let js = try ParityProcess.run(
            executable: bun, arguments: ["cli.js", testCase.verb] + testCase.args,
            environment: Self.jsEnvironment(home: fixture.jsHomeDirectory),
            currentDirectory: appleDocsRoot)
        let swift = try ParityProcess.run(
            executable: adCli,
            arguments: [testCase.verb] + testCase.args + ["--db", fixture.swiftDatabasePath],
            environment: Self.swiftEnvironment, currentDirectory: appleDocsRoot)

        let comparison = Self.compare(testCase, js: js, swift: swift)

        #expect(js.exitCode == testCase.expectedExitCode, "cli.js exit code (stderr: \(js.stderr))")
        #expect(
            swift.exitCode == testCase.expectedExitCode, "ad-cli exit code (stderr: \(swift.stderr))")
        #expect(comparison.isMatch, "\(comparison.detail)")
    }

    /// Env for every `cli.js` invocation: the mandatory native kill switch, the fixture home, and
    /// the two determinism knobs both engines honor identically (`APPLE_DOCS_SEMANTIC=off` so
    /// neither's semantic tier can introduce nondeterminism; `APPLE_DOCS_SKIP_UPDATE_CHECK=1` so
    /// `status`/`version` never attempt a live GitHub call).
    private static func jsEnvironment(home: String) -> [String: String] {
        [
            "APPLE_DOCS_NATIVE": "off",
            "APPLE_DOCS_HOME": home,
            "APPLE_DOCS_SEMANTIC": "off",
            "APPLE_DOCS_SKIP_UPDATE_CHECK": "1"
        ]
    }

    /// Env for every `ad-cli` invocation — the same two determinism knobs (`ad-cli` reads the exact
    /// same env var names; see Search.swift's `loadSearchSemanticContext` and Status.swift's
    /// `gatherStatus`). `--db` supplies the corpus directly, so no `APPLE_DOCS_HOME` equivalent
    /// is needed.
    private static let swiftEnvironment: [String: String] = [
        "APPLE_DOCS_SEMANTIC": "off", "APPLE_DOCS_SKIP_UPDATE_CHECK": "1"
    ]

    private static func compare(_ testCase: ParityCase, js: ProcessOutcome, swift: ProcessOutcome)
        -> ParityJSON.Comparison
    {
        switch testCase.format {
            case .json:
                // The deliberate error-path case expects EMPTY stdout on both sides (browse's
                // documented contract). Parsing "" as JSON would misreport as a parse failure, so
                // both-empty is routed straight to a textual read — an ASYMMETRIC "only one side
                // printed nothing" still falls through to `ParityJSON.compare` below, which reports
                // it as a real parse-failure mismatch (exactly what it would be).
                if js.stdout.isEmpty, swift.stdout.isEmpty {
                    return ParityJSON.Comparison(isMatch: true, detail: "both stdout empty")
                }
                return ParityJSON.compare(
                    lhsLabel: "cli.js", lhsText: js.stdout, rhsLabel: "ad-cli", rhsText: swift.stdout,
                    excludedPaths: testCase.excludedJSONPaths)
            case .human:
                if js.stdout == swift.stdout {
                    return ParityJSON.Comparison(isMatch: true, detail: "byte-identical")
                }
                return ParityJSON.Comparison(
                    isMatch: false,
                    detail: """
                        human output mismatch:
                        --- cli.js ---
                        \(js.stdout)
                        --- ad-cli ---
                        \(swift.stdout)
                        """)
        }
    }
}
