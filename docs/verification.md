# Verification

How the Swift implementation is checked against the Bun reference (`g-cqd/apple-docs` `main`) and against
hostile input. Everything here runs locally; CI runs the same commands from `.ci/action.json`.

## Differential parity with Bun

| Check | What it compares | How to run |
|---|---|---|
| DocC golden files | `DocCJSONConverter` output (document fields, every section's `content_text` / `content_json` / sort slot, relationships) and `BunMarkdownRenderer` output, against Bun's `normalize()` + `renderMarkdown()` on 12 committed DocC inputs (symbols, REST endpoints, HIG, articles, synthetic edge cases) | `swift test --filter DocCNormalizationParity`; regenerate with `bun Scripts/generate-docc-parity-golden.mjs ../apple-docs` |
| Live corpus diff | Two databases synced from the live site by each implementation: documents, sections (incl. zstd-compressed Bun cells), relationships | `Scripts/diff-bun-corpus.py swift.db bun.db --strict` |
| MCP tool outputs | `tools/call` results of both servers over the same corpus, structurally (32 default cases: every `read_doc` mode incl. pagination/sections/match/errors, `browse`, `list_frameworks`, `list_taxonomy`, asset tools) | `Scripts/diff-mcp-tools.py --bun "bun ../apple-docs/cli.js mcp start" --swift ".build/debug/apple-docs mcp stdio --db <db>"` (`--cases file.json` for custom sets) |

Status: Compression (66 pages) and PDFKit (740) live corpora are identical; MCP outputs are identical for 32/32
default cases, 120/122 sampled paginated `read_doc` calls, and 105/106 `search_docs` calls covering random titles,
intents, typos, relaxation, framework/source/kind/minVersion/deprecated/year filters, pagination, and `read=true`
(semantic tier on, over the full imported corpus). The only known difference: 693 imported keys with uppercase
characters (the Swift corpus lowercases keys; Bun keeps their case), which shows up in paths.

## Fuzzing

`Fuzz/` is a separate package of libFuzzer harnesses (Linux toolchains ship libFuzzer). Every harness must hold
its invariant for any input, under AddressSanitizer:

| Harness | Input | Invariant |
|---|---|---|
| `FuzzDocumentKey` | key text | accepted keys are stable and contain no `..` segment |
| `FuzzDocCConverter` | DocC render JSON | no trap; no self-relationship; Markdown and stored-JSON rendering succeed |
| `FuzzHTMLConverter` / `FuzzMarkdownConverter` | page bytes | no trap |
| `FuzzLinkMapping` | identifiers / URLs | normalized keys are lowercase with no empty segment |
| `FuzzFTSQuery` | search text | FTS5 queries never contain an unbalanced `"` |
| `FuzzZstd` | zstd frames | no trap; decoded size cap enforced |
| `FuzzWebMarkdown` | stored Markdown | output tags are renderer-authored only; no handlers, no `javascript:` |

Run one with `Fuzz/run.sh <Harness> [seconds]`, all with `Fuzz/ci.sh` (nightly in CI). Seeds live in
`Fuzz/Corpus/<Harness>`; findings land in `Fuzz/Artifacts/<Harness>/`.

## Benchmarks

- `Benchmarks/` (ordo-one `benchmark`): search, MCP `read_doc` (plain and paginated), web page rendering, and DocC
  normalization over a deterministic 20k-document synthetic corpus; CI compares instructions and allocations
  with the previous commit on every push touching `Sources/`. Run: `swift package --package-path Benchmarks benchmark`.
- `Benchmarks/compare-bun-sync.sh <framework> <runs> <concurrency>`: cold crawl of one framework, both
  implementations, alternating order.
- `Benchmarks/compare-bun-mcp.py --bun … --swift … [--db corpus.db]`: per-call MCP latency (p50/p90/p99),
  interleaved between the servers, for repeated (cache-hitting) and, with `--db`, cold sampled calls, plus RSS.
  Cold latency is dominated by OS page-cache residency of each database file, so give Bun a fresh copy of its
  database (`mcp start --home DIR`) made alongside the Swift one. Measured that way over the full corpus (cold,
  distinct pages, MCP cache off): `read_doc` p50 8.8 ms (Swift) vs 9.4 ms (Bun), p99 42.6 vs 43.4 ms; paginated
  p50 7.4 vs 7.1 ms, p99 28.4 vs 34.1 ms; RSS 99 vs 182 MiB. Warm, both serve a page in ~0.14 ms. `search_docs`
  (semantic tier on, 200 random titles): p50 46 vs 45 ms, p90 112 vs 131 ms, p99 416 vs 375 ms, RSS 609 vs 612 MiB.

## Release path

`swift-ci run archive-macos` / `archive-linux` and `swift-ci publish --dry-run` were exercised end to end for
v2.0.0-alpha.1 (no tag pushed). The macOS archive is signed with Developer ID and the hardened runtime and passes
`codesign --verify --strict`; it ships `libswiftCompatibilitySpan.dylib` (Apple-signed, needed below macOS 26) with
only portable rpaths (`/usr/lib/swift`, then `@loader_path`), and a hardened process loads the bundled copy. The
Linux archive bundles the Swift runtime and runs with the build toolchain hidden. Both archives are single
executables: resources are compiled in (`Scripts/embed-resources.py`), so no SwiftPM resource bundle has to travel
with the binary. `publish` produces the archives, a SwiftPM artifact bundle, a CycloneDX 1.5 SBOM, checksums, and the
filled release note. Notarization runs in CI from the `NOTARY_*` secrets and fails closed on tags without them; it
was not submitted from this dry run.

## Other gates

`Scripts/dependency-audit.sh` (declared vs imported target dependencies), `Scripts/check-layers.py` (ADR-0001
layering), the swift-ci quality suite (swift-format, SwiftLint, discipline, deadwood, dolly, arcleak, fcheck,
modeler), and nightly mutation testing with litmus over Core, Output, Storage, and Search.
