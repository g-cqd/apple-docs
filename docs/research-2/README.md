# apple-docs Codex Research

Research bundle generated on 2026-04-13 for the local `apple-docs` project.

This folder complements the existing draft report in `docs/report.md`. It is based on:

- The current local `apple-docs` codebase
- The repos explicitly provided by the user
- Additional active concurrent projects discovered before the analysis started
- Repository metadata fetched from GitHub on 2026-04-13

## Files

- [01-competitive-landscape.md](./01-competitive-landscape.md)
  Competitive review of the current market and adjacent repos.
- [02-current-state-audit.md](./02-current-state-audit.md)
  Code-grounded audit of the current `apple-docs` implementation.
- [03-gap-analysis.md](./03-gap-analysis.md)
  Capability-by-capability comparison and the concrete missing pieces.
- [04-architecture-proposal.md](./04-architecture-proposal.md)
  Proposed target architecture focused on Bun, JavaScript/TypeScript, reliability, and scale.
- [05-static-site-and-storage-investigation.md](./05-static-site-and-storage-investigation.md)
  Static web export, search strategy, command taxonomy, and markdown storage investigation.
- [06-implementation-roadmap.md](./06-implementation-roadmap.md)
  Detailed phased completion plan.

## Executive Summary

`apple-docs` already has the best raw technical foundation for a serious offline Apple docs platform:

- It uses Apple’s DocC JSON API directly instead of depending on browser crawling.
- It already runs on Bun with zero npm dependencies.
- It already has a local corpus model, resumable sync, SQLite FTS5, trigram title search, and an MCP surface.
- It already supports HIG and App Store Review Guidelines, which some competitors do not.

The current weaknesses are not foundational. They are coverage, distribution, protocol hardening, and productization:

- `apple-docs` currently indexes far fewer source families than `cupertino`.
- The MCP server is hand-rolled instead of using the official SDK.
- Search quality is good but still materially behind the strongest competitor in ranking heuristics, filtering, and source blending.
- Distribution is still “build and crawl locally”, while competitors increasingly ship prebuilt artifacts or npm-first packages.
- There is no static web output path yet.
- Markdown is currently treated as a required materialization instead of an optional cache.

## Core Recommendation

The best path is not to imitate the competitors directly.

The winning strategy is to turn `apple-docs` into:

1. A Bun-first offline Apple documentation platform with a canonical normalized content model.
2. A multi-source indexer covering Apple DocC, HIG, App Store Review Guidelines, Swift Evolution, Swift.org, Swift book, Apple Archive, WWDC, sample code, and package metadata.
3. A shared search engine that powers both MCP and a fully static web build.
4. A storage system where Markdown and HTML are optional derived artifacts, not mandatory primary storage.
5. A command model where `web serve` / `web deploy` are reserved for the website and MCP startup moves under `mcp`.

## Short Verdict

If the goal is to become more complete than the current competitors while staying trustworthy, reliable, fast, and efficient, the priority order should be:

1. Fix the architecture seams in the current project.
2. Expand source coverage.
3. Harden search and metadata quality.
4. Add reproducible distribution.
5. Add the static website as a first-class output target.

That sequencing preserves the current structural advantage instead of burying it under premature UI or embeddings work.
