# Audit 4 — Findings Brief

**Date:** 2026-05-09
**Scope:** static review of web routes, MCP server, asset rendering, storage/path helpers, setup/snapshot/storage commands; ran `bun audit`. No edits made.

## Findings

- **High:** Unauthenticated render endpoints can be used for CPU, disk, and memory exhaustion. `src/web/routes/fonts.route.js:104` passes arbitrary text into `renderFontText`; `src/resources/apple-assets.js:521` keeps it unbounded, fallback SVG width scales with text length, and native rendering spawns Swift. Symbols have a similar issue: `src/web/routes/symbols.route.js:63` live-renders arbitrary parameter combinations, while `src/resources/apple-assets.js:457` keys the persistent cache by color/size/weight/scale and writes files. Add text caps, parameter allowlists or quantization, render timeouts, web-side concurrency/rate limits, and cache eviction.

- **High:** The MCP HTTP server buffers the full POST body before validation. `src/mcp/http-server.js:193` calls `await request.text()` without a size cap, and `src/mcp/http-server.js:118` allows any CORS origin when no `--allow-origin` is configured. If this is bound beyond loopback or placed behind a permissive proxy, large POSTs to `/mcp` can exhaust memory. Add Content-Length rejection, a streaming read limit, and stricter exposed-server defaults.

- **Medium:** `keyPath` does not reject traversal segments. `src/lib/safe-path.js:76` joins caller-supplied key segments directly under `dataDir/subdir`; persistence uses that path for raw and normalized documents in `src/pipeline/persist.js:34` and `src/pipeline/persist.js:113`. Any source key containing `..` can read or write outside the intended storage root. Centralize segment validation and reject `.`, `..`, empty segments, slashes inside decoded segments, and absolute paths.

- **Medium:** `setup` extracts downloaded archives directly into the data directory. `src/commands/setup.js:103` treats checksums as optional, and `src/commands/setup.js:151` runs `tar -xzf ... -C dataDir` without validating member paths. A malformed or compromised release archive could write outside `dataDir`. Require checksum validation when installing releases, inspect tar entries for absolute paths/traversal, extract to a temp dir, then move expected files.

- **Medium:** MCP `search_docs.limit` is unbounded. `src/mcp/server.js:74` accepts any numeric limit, and `src/commands/search.js:31` only enforces a minimum. Remote callers can request very large result windows and responses. Clamp this in both schema and command code.

- **Low:** `bun audit` reports transitive advisories through `package.json:65`, including high-severity `fast-uri` issues via `@modelcontextprotocol/sdk` and moderate Hono/IP address issues. Update the lockfile/dependencies and re-run the audit.

- **Low:** `storage gc --older-than` appears broken. `src/commands/storage.js:112` deletes from `activity.timestamp`, but the schema defines `started_at` in `src/storage/database.js:97`. That path will fail when `olderThan` is used.
