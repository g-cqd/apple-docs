// The Tier 1 fixed arg matrix (RFC 0007 §12): one `ParityCase` per verb+args combination this gate
// drives through BOTH `cli.js` and `ad-cli`. Read-only verbs only, per RFC 0007 §8/P7.1 — `sync`,
// `setup`, `crawl`, and every write/maintenance verb are out of scope for this fast, deterministic,
// fixture-driven tier (P7.2 gates those against a scratch corpus instead).

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
    /// Non-nil marks a case that hits a KNOWN, already-diagnosed, tracked divergence — the
    /// comparison still runs for real every time (via `withKnownIssue`), but a failure there is
    /// recorded as a known issue rather than failing the suite. See the constants below for the
    /// specific findings this currently covers.
    var knownIssue: String?

    var description: String {
        let label = args.isEmpty ? verb : "\(verb) \(args.joined(separator: " "))"
        return knownIssue == nil ? label : "\(label) [known issue]"
    }
}

extension ParityCase {
    // MARK: - documented volatile-field exclusions (status)

    /// Fields the DEFAULT `status --json` shape can never byte-for-byte agree on across a SQLite
    /// fixture (JS) and an ADDB fixture (Swift) derived from it via `ad-cli import`: the absolute
    /// fixture directory (a fresh temp path per test run on each side), the byte-exact database
    /// FILE size (two different storage engines' on-disk encodings of the same logical data — never
    /// comparable), and the two content-cache directories this harness deliberately does not commit
    /// (see FixtureRegeneration.swift's header). Both engines report `{size:0,files:0}` for those on
    /// a PRISTINE fixture copy, but JS's `read`/`search --read` verbs write a markdown render-cache
    /// back to disk as a side effect of rendering — relying on "both coincidentally report zero"
    /// would be fragile the moment case ordering changes, so the fields are excluded outright rather
    /// than trusted to coincide. `freshness.daysSinceSync` is derived from wall-clock "now" at the
    /// moment each engine is invoked — both read it within the same test run, moments apart, so it
    /// matches in practice, but it is fundamentally time-of-test-run dependent, like a timestamp, so
    /// it's excluded on principle rather than by lucky timing.
    static let statusVolatilePaths: Set<String> = [
        "dataDir", "databaseSize", "rawJson", "markdown", "freshness.daysSinceSync"
    ]

    /// Everything `statusVolatilePaths` excludes, PLUS `capabilities.searchBody` — a NEW finding
    /// from building this harness (not one of RFC 0007 §11's original findings):
    /// `StorageConnection.hasBodyIndex()`'s existence probe (`SELECT 1 FROM documents_body_fts
    /// LIMIT 1`, no MATCH predicate) returns false against an `ad-cli import`-derived ADDB corpus
    /// even though body-tier search demonstrably WORKS there — proven by this same harness's
    /// `search "alphanumeric"` case (a body-only term absent from every title/abstract), which
    /// returns byte-identical hits on both engines. Most likely an ADDB FTS5-shim quirk (an
    /// unqualified, no-MATCH scan of a contentless/self-contained FTS5 table behaves differently
    /// there than in real SQLite), not a search-functionality bug — but the PROBE itself reads wrong
    /// on an imported corpus, so `capabilities.searchBody` is excluded here rather than asserted
    /// false. Out of this harness's scope to fix (it's an ADStorage/ADDB-engine question); noted for
    /// a follow-up.
    static let statusAdvancedVolatilePaths: Set<String> = statusVolatilePaths.union(["capabilities.searchBody"])

    // MARK: - documented known issues

    /// A NEW finding from building this harness — NOT a reproduction of RFC 0007 §11 finding #8
    /// (that one, `Browse.swift`'s `pagesByRoot` joining `pages.path = documents.key`, already
    /// landed a fix in `2e657e7`: the join now reads `pages.path = documents.url`, and this
    /// harness confirms it works — `browse <framework> --json` against the real, natively-crawled
    /// production corpus (`~/.apple-docs/apple-docs.db`) returns real pages, not empty).
    ///
    /// The DISTINCT bug this harness actually found: `ad-cli import`'s SQLite→ADDB manifest
    /// (`ImportVerb.swift`) auto-copies the `pages` table verbatim — `pages` appears in none of
    /// its `skipTables`/`ftsTables`/`denorm` lists — but the JS crawler's `pages.path` column
    /// holds a BARE relative path (`persist.js`'s `upsertPage` passes `path` straight through;
    /// the full URL goes into a SEPARATE `pages.url` column via `defaultDoccUrl`), whereas the
    /// (now-fixed) `pagesByRoot` join assumes `pages.path == documents.url` — true for a
    /// NATIVELY-crawled corpus (`CrawlDriver`/`CrawlPersist` write `page.document.url` straight
    /// into `pages.path`) but never true for a corpus obtained by importing a bare JS SQLite
    /// export, exactly what this harness's own Tier 1 fixture-generation recipe does (for
    /// determinism — see FixtureRegeneration.swift's header). A subsequent native crawl pass
    /// would self-heal it (native upserts overwrite `pages.path` with the full URL), which is the
    /// likely reason the live production corpus — imported once, then repeatedly re-crawled
    /// natively — shows no symptom today; a fixture that is ONLY ever imported, never
    /// native-crawled, has no such healing pass. Out of this harness's scope to fix (it's an
    /// `ad-cli import` manifest question — probably wants a `pages.path ← pages.url` denorm rule
    /// alongside the existing `documents` denorm block); tracked as a follow-up.
    static let importedCorpusPagesPathFinding =
        "NEW finding (this harness) — ad-cli import copies pages.path verbatim from a bare-path "
        + "JS SQLite export, so the (already-fixed) pagesByRoot join (pages.path == documents.url) "
        + "never matches on an import-derived corpus, even though it works on a natively-crawled one."
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

        // MARK: status — JSON only. The human formatter inlines the absolute `dataDir` path and the
        // byte-exact formatted database size, both INHERENTLY different between a SQLite fixture and
        // an ADDB fixture derived from it — there is no field-level exclusion mechanism for free
        // text the way there is for JSON, so human `status` byte-identity was never a meaningful
        // target for this fixture and is deliberately left out of the matrix (documented, not an
        // oversight).
        ParityCase(
            verb: "status", args: ["--json"], format: .json,
            excludedJSONPaths: ParityCase.statusVolatilePaths),
        ParityCase(
            verb: "status", args: ["--advanced", "--json"], format: .json,
            excludedJSONPaths: ParityCase.statusAdvancedVolatilePaths),

        // MARK: browse — the default page-listing variant hits the imported-corpus pages.path
        // finding (see the constant's doc comment — NOT RFC 0007 §11 finding #8, which already
        // landed a fix); both engines are still driven for real every run via `withKnownIssue`,
        // so a fix is caught the moment it lands. The `--path` (children) variant walks a
        // different query (`documentChildren`, not `pagesByRoot`) and is unaffected — a clean,
        // must-pass case.
        ParityCase(
            verb: "browse", args: ["adsupport", "--json"], format: .json,
            knownIssue: ParityCase.importedCorpusPagesPathFinding),
        ParityCase(
            verb: "browse", args: ["adsupport"], format: .human,
            knownIssue: ParityCase.importedCorpusPagesPathFinding),
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
        // itself works identically despite the `capabilities.searchBody` probe finding above),
        // `--read` combined mode, and a no-results query. `APPLE_DOCS_SEMANTIC=off` is set
        // process-wide by the test driver so neither engine's semantic tier can introduce
        // nondeterminism (the fixture carries no indexed vectors/chunks anyway, so both would
        // already degrade to lexical-only — the env var makes that intentional rather than
        // coincidental).
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
