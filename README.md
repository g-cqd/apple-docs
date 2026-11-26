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

## Architecture & documentation

- [`docs/adr/0001-swift-architecture-and-layering.md`](docs/adr/0001-swift-architecture-and-layering.md) — module graph, cross-platform vs Darwin setup split, storage/search strategy, and upstream package promotion policy.
- [`docs/quality.md`](docs/quality.md) — enforced compiler, lint, structure, and static-analyzer gates.
- [`docs/threat-model.md`](docs/threat-model.md) — trust boundaries, security invariants, and threat register.
- [`SECURITY.md`](SECURITY.md) — vulnerability disclosure and release verification.

## License

[MIT](LICENSE).
