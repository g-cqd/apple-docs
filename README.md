# apple-docs (Swift)

Cross-platform Swift 6.4 CLI, MCP server (stdio + Streamable HTTP), local website/SSG, and corpus setup toolchain for offline Apple developer documentation.

Runs natively on **macOS 15+** and **Linux (x86_64 / arm64)**:

- **Runtime & servers (macOS + Linux):** CLI, MCP server (`stdio` and Streamable HTTP via `g-cqd/HTTP`), local web server & static site builder, hybrid SQLite + `AemiSearch` retrieval, clean Swift v1 corpus schema plus read-only v31 Bun corpus importer.
- **Setup & authoring (cross-platform + Darwin-gated):** cross-platform snapshot verification/install and upstream crawling on both macOS and Linux; macOS-only asset pipelines (CoreGlyphs SF Symbols catalog/prerender, CoreText text rendering, DMG/pkg extraction, local Xcode MobileAsset enrichment) isolated in `AppleDocsSetupDarwin`.

## Build and test

```sh
swift build
swift test
.ci/swift-ci run quality
python3 -B Scripts/check-layers.py && python3 -B Scripts/test-layers.py
```

## Serving and exporting

```sh
# Local website + read-only JSON API (pages: /, /search, /doc/<key>, /symbols, /fonts, /sitemap.xml)
apple-docs web serve --port 3134 [--base-url https://docs.example] [--no-metrics]

# Static site (same pages, assets, sitemaps, client-side title search); rebuilds replace the output directory
# atomically. A base URL with a path (e.g. GitHub Pages) roots every link under that path.
apple-docs web build ./dist --base-url https://user.github.io/apple-docs --max-pages 1000000 --concurrency 8

# MCP over Streamable HTTP
apple-docs mcp serve --port 3133
```

Both servers share one `g-cqd/HTTP` chain: request IDs, per-peer rate limiting (`--rate-limit`), RED metrics
(Prometheus text at `/metrics`, exposed by default only on loopback binds; `--metrics` / `--no-metrics`),
security headers, `Date`, `ETag`/`304` validators, and Brotli/gzip content coding.

## Architecture & documentation

- [`docs/adr/0001-swift-architecture-and-layering.md`](docs/adr/0001-swift-architecture-and-layering.md) — module graph, cross-platform vs Darwin setup split, storage/search strategy, and upstream package promotion policy.
- [`docs/quality.md`](docs/quality.md) — enforced compiler, lint, structure, and static-analyzer gates.
- [`docs/threat-model.md`](docs/threat-model.md) — trust boundaries, security invariants, and threat register.
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure and release verification.
- [`docs/verification.md`](docs/verification.md) — Bun parity checks, fuzzing, and benchmarks.

## License

[MIT](LICENSE).
