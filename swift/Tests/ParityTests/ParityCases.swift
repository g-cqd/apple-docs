// The Tier 1 fixed arg matrix (RFC 0007 §12): one `ParityCase` per verb+args combination this gate
// drives through BOTH `cli.js` and `ad-cli`. Read-only verbs only, per RFC 0007 §8/P7.1 — `sync`,
// `setup`, `crawl`, and every write/maintenance verb are out of scope for this fast, deterministic,
// fixture-driven tier (P7.2 gates those against a scratch corpus instead).
//
// Zero known issues: every case must pass outright. The two divergences this harness originally
// tracked via `withKnownIssue` (RFC 0007 §11 findings #9/#10) were obsoleted by the storage pivot —
// the corpus is one SQLite format again, `pages.path` is the bare crawl key on both engines, and
// the real-FTS5 `hasBodyIndex` probe reads true — so the known-issue plumbing is deleted rather
// than left as an empty mechanism.

/// One verb+args parity case. The argument LIST is shared, identical text for both engines — the
/// flag-name audit behind this harness (cross-checking `cli.js --help` / `src/cli/help.js` against
/// `ad-cli`'s `ArgumentParser` declarations in `Sources/ADCLI/*.swift`) confirmed every flag here
/// spells identically on both sides, including the kebab-case long names ArgumentParser derives
/// from a camelCase property (`--max-chars`, `--min-ios`, ...) matching cli.js's own kebab-case
/// flags 1:1. `--db <path>` (Swift) / `APPLE_DOCS_HOME=<dir>` (JS) are appended by the test driver,
/// not listed here, since they're engine-specific plumbing rather than part of the verb's surface.
struct ParityCase: Sendable, CustomStringConvertible {
    enum OutputFormat: Sendable {
        /// Compared intrinsically: parsed as JSON, volatile fields redacted, deep-equal (object
        /// members unordered, arrays order-sensitive) — RFC 0007 §3/§9's "JSON... via ADJSON".
        case json
        /// Compared byte-for-byte (RFC 0007 §3/§9's "human output byte-for-byte"). Neither engine
        /// emits ANSI styling under a `Process`-piped (non-TTY) stdout (both gate `bold`/`dim` on an
        /// `isatty`/`process.stdout.isTTY` check), so this is a plain-text comparison in practice.
        case human
    }

    let verb: String
    let args: [String]
    let format: OutputFormat
    /// The exit code BOTH engines must produce (asserted against each engine individually, not just
    /// against each other — a coincidental non-zero match on both sides would still be wrong).
    var expectedExitCode: Int32 = 0
    /// Dotted JSON paths redacted from BOTH sides before comparing (see `ParityJSON.redacting`).
    /// Only meaningful for `.json` cases.
    var excludedJSONPaths: Set<String> = []

    var description: String {
        args.isEmpty ? verb : "\(verb) \(args.joined(separator: " "))"
    }
}

extension ParityCase {
    // MARK: - documented volatile-field exclusions (status)

    /// Fields `status --json` can never reliably byte-for-byte agree on across the two engines'
    /// fixture copies, even now that both copies are the SAME SQLite bytes: the absolute fixture
    /// directory (a fresh temp path per test run on each side), and the two content-cache
    /// directories this harness deliberately does not commit (see FixtureRegeneration.swift's
    /// header) — both engines report `{size:0,files:0}` for those on a PRISTINE copy, but JS's
    /// `read`/`search --read` verbs write a markdown render-cache back to disk as a side effect of
    /// rendering, so "both coincidentally report zero" would be fragile the moment case ordering
    /// changes. `databaseSize` stats a LIVE file each engine has already opened — the JS open flips
    /// the fixture copy to WAL and can leave checkpoint effects, so the byte-exact size is an
    /// artifact of each engine's own open, not of the corpus; excluded on principle rather than
    /// trusted to coincide. `freshness.daysSinceSync` is derived from wall-clock "now" at the
    /// moment each engine is invoked — both read it within the same test run, moments apart, so it
    /// matches in practice, but it is fundamentally time-of-test-run dependent, like a timestamp,
    /// so it too is excluded on principle. `capabilities.searchBody` (once excluded here for the
    /// ADDB FTS-shim probe false-negative, RFC 0007 §11 finding #10) now compares for real — the
    /// probe runs against genuine FTS5 on both sides.
    static let statusVolatilePaths: Set<String> = [
        "dataDir", "databaseSize", "rawJson", "markdown", "freshness.daysSinceSync"
    ]
}

enum ParityCases {
    /// The fixed matrix. Ordering is cosmetic (Swift Testing reports each case independently); it
    /// follows the verb order in RFC 0007 §3's table.
    static let all: [ParityCase] = [
        // MARK: version — no corpus-shaped data; the `commit` field is expected to match exactly
        // (both engines resolve `git rev-parse --short HEAD` from within this same checkout), not
        // merely structurally, so this is compared with no exclusions at all.
        ParityCase(verb: "version", args: [], format: .human),
        ParityCase(verb: "version", args: ["--json"], format: .json),

        // MARK: frameworks — the RFC 0007 §11 finding #1 regression guard: a `page_count`
        // regression would make `--json`'s `total` jump from 3 back to 393 (every catalog-stub
        // root the technologies-index discovery step records but never crawls).
        ParityCase(verb: "frameworks", args: [], format: .human),
        ParityCase(verb: "frameworks", args: ["--json"], format: .json),
        ParityCase(verb: "frameworks", args: ["--kind", "framework", "--json"], format: .json),
        ParityCase(verb: "frameworks", args: ["--kind", "bogus-kind-no-match", "--json"], format: .json),

        // MARK: kinds — broad (all 5 fields) + single-field shapes, human + json.
        ParityCase(verb: "kinds", args: [], format: .human),
        ParityCase(verb: "kinds", args: ["--json"], format: .json),
        ParityCase(verb: "kinds", args: ["--field", "role", "--json"], format: .json),
        ParityCase(verb: "kinds", args: ["--field", "kind"], format: .human),

        // MARK: status — JSON only. The human formatter inlines the absolute `dataDir` path (a
        // fresh temp path per engine per case), and there is no field-level exclusion mechanism
        // for free text the way there is for JSON, so human `status` byte-identity was never a
        // meaningful target for this fixture and is deliberately left out of the matrix
        // (documented, not an oversight). `--advanced` compares `capabilities.searchBody` for
        // real — the once-excluded ADDB-shim probe false-negative (RFC 0007 §11 finding #10) is
        // architecturally gone.
        ParityCase(
            verb: "status", args: ["--json"], format: .json,
            excludedJSONPaths: ParityCase.statusVolatilePaths),
        ParityCase(
            verb: "status", args: ["--advanced", "--json"], format: .json,
            excludedJSONPaths: ParityCase.statusVolatilePaths),

        // MARK: browse — the default page-listing variant is the RFC 0007 §11 findings #8/#9
        // full-circle regression guard: `pagesByRoot` runs the literal JS join
        // (`pages.path = documents.key`), correct on both engines' corpora now that the storage
        // pivot converged `pages.path` on the bare crawl key. These two cases were this harness's
        // last `withKnownIssue` entries; they must now pass outright. The `--path` (children)
        // variant walks a different query (`documentChildren`, not `pagesByRoot`).
        ParityCase(verb: "browse", args: ["adsupport", "--json"], format: .json),
        ParityCase(verb: "browse", args: ["adsupport"], format: .human),
        ParityCase(
            verb: "browse", args: ["signinwithapple", "--path", "signinwithapple", "--json"],
            format: .json),
        ParityCase(
            verb: "browse",
            args: [
                "apptrackingtransparency", "--path", "apptrackingtransparency/attrackingmanager", "--json"
            ], format: .json),
        // The deliberate error path: cli.js's `browse.js` throws NotFoundError → `Error: <message>`
        // on stderr + exit 1 + EMPTY stdout; `ad-cli`'s `failBrowse` mirrors that contract exactly
        // (Main.swift's own doc comment names it as such). Proves the harness's exit-code assertion
        // actually discriminates (a diverging exit code here would be caught), not just its JSON/text
        // comparison.
        ParityCase(verb: "browse", args: ["bogus-framework-xyz"], format: .human, expectedExitCode: 1),

        // MARK: read — path lookup, symbol lookup, pagination, a root/technology page, a leaf
        // property, and an enum with Cases/Relationships sections. All byte-identical once the
        // fixture excludes the JS-only on-disk markdown render-cache (see FixtureRegeneration.swift's
        // header) so both engines take the SAME "render on demand from DB sections" path rather than
        // JS preferentially reading a stale pre-materialized `.md` file.
        ParityCase(verb: "read", args: ["adsupport/asidentifiermanager", "--json"], format: .json),
        ParityCase(
            verb: "read", args: ["adsupport/asidentifiermanager/advertisingidentifier", "--json"],
            format: .json),
        ParityCase(
            verb: "read",
            args: ["apptrackingtransparency/attrackingmanager/authorizationstatus", "--json"],
            format: .json),
        ParityCase(verb: "read", args: ["signinwithapple", "--json"], format: .json),
        ParityCase(
            verb: "read", args: ["ASIdentifierManager", "--framework", "adsupport", "--json"],
            format: .json),
        ParityCase(
            verb: "read",
            args: ["adsupport/asidentifiermanager", "--max-chars", "300", "--page", "1"],
            format: .human),

        // MARK: search — lexical cascade, filtered, a body-only term (proves the FTS body tier
        // works identically), `--read` combined mode, and a no-results query.
        // `APPLE_DOCS_SEMANTIC=off` is set process-wide by the test driver so neither engine's
        // semantic tier can introduce nondeterminism (the fixture carries no indexed
        // vectors/chunks anyway, so both would already degrade to lexical-only — the env var makes
        // that intentional rather than coincidental).
        ParityCase(verb: "search", args: ["AdSupport", "--json"], format: .json),
        ParityCase(verb: "search", args: ["alphanumeric", "--json"], format: .json),
        ParityCase(
            verb: "search", args: ["tracking", "--framework", "apptrackingtransparency", "--json"],
            format: .json),
        ParityCase(verb: "search", args: ["Sign in with Apple"], format: .human),
        ParityCase(verb: "search", args: ["authorization", "--read", "--json"], format: .json),
        // A genuinely empty result set (gibberish with no fuzzy/relaxed match at all — verified
        // both engines print the bare "No results for ..." line, no relaxed fallback fires).
        ParityCase(verb: "search", args: ["qxzvbjklmwpqrst"], format: .human),
        // The relaxed-preamble regression guard (formerly a known-issue finding, fixed):
        // this hyphenated nonsense phrase's tokens still relax-match real content, so the
        // ENTIRE result set is relaxed-tier and both formatters must print the
        // "Showing best-effort matches (query relaxed)." preamble.
        ParityCase(verb: "search", args: ["zzz-no-such-query-should-match-nothing"], format: .human)
    ]
}
