# Verification

How the Swift implementation is checked against the Bun reference (`g-cqd/apple-docs` `main`) and against
hostile input. Everything here runs locally; CI runs the same commands from `.ci/action.json`.

## Differential parity with Bun

| Check | What it compares | How to run |
|---|---|---|
| DocC golden files | `DocCJSONConverter` output (document fields, every section's `content_text` / `content_json` / sort slot, relationships) and `BunMarkdownRenderer` output, against Bun's `normalize()` + `renderMarkdown()` on 12 committed DocC inputs (symbols, REST endpoints, HIG, articles, synthetic edge cases) | `swift test --filter DocCNormalizationParity`; regenerate with `bun Scripts/generate-docc-parity-golden.mjs ../apple-docs` |
| Live corpus diff | Two databases synced from the live site by each implementation: documents, sections (incl. zstd-compressed Bun cells), relationships | `Scripts/diff-bun-corpus.py swift.db bun.db --strict` |
| MCP tool outputs | `tools/call` results of both servers over the same corpus, structurally (32 default cases: every `read_doc` mode incl. pagination/sections/match/errors, `browse`, `list_frameworks`, `list_taxonomy`, asset tools) | `Scripts/diff-mcp-tools.py --bun "bun ../apple-docs/cli.js mcp start" --swift ".build/debug/apple-docs mcp stdio --db <db>"` (`--cases file.json` for custom sets) |

Status: Compression (66 pages) and PDFKit (740) live corpora are identical; MCP outputs are identical for 30/32
default cases and 120/122 sampled paginated `read_doc` calls. Known differences: `search_docs` ranking (Bun's
search cascade is not ported yet) and 693 imported keys with uppercase characters (the Swift corpus lowercases
keys; Bun resolves them case-sensitively).

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
- `Benchmarks/compare-bun-mcp.py --bun … --swift … [--db corpus.db]`: per-call MCP latency (p50/p90/p99) for
  repeated (cache-hitting) and, with `--db`, cold sampled calls, plus server RSS.

## Other gates

`Scripts/dependency-audit.sh` (declared vs imported target dependencies), `Scripts/check-layers.py` (ADR-0001
layering), the swift-ci quality suite (swift-format, SwiftLint, discipline, deadwood, dolly, arcleak, fcheck,
modeler), and nightly mutation testing with litmus over Core, Output, Storage, and Search.
