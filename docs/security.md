# Security policy

## Reporting a vulnerability

If you discover a security issue in apple-docs (CLI, web server, or MCP
HTTP server), please report it privately rather than opening a public
issue.

**Preferred channel:** open a [GitHub private security advisory](https://github.com/g-cqd/apple-docs/security/advisories/new)
on this repository. GitHub notifies the maintainer; the discussion
stays private until a fix and disclosure timeline are agreed.

If GitHub advisories are unavailable to you, send an email to the
address listed under "Contact" on the GitHub profile of the repository
owner. Use PGP if you can; the maintainer responds with a key on first
contact if the message is unencrypted.

Please include:

- A description of the vulnerability and its impact.
- Reproduction steps (a minimal proof-of-concept is ideal).
- The version (`apple-docs --version`) or commit SHA you observed it on.
- Any mitigations you have already identified.

The project aims to respond within **three business days** with an
acknowledgement and an expected timeline. Coordinated disclosure is
preferred; the reporter is credited in the release notes unless they
ask otherwise.

## Supported versions

There is one supported version: whatever is on `main`. The project has
no semver release line and no maintained backport branches. Security
fixes land on `main` and reach users through:

- The **next weekly snapshot** (`snapshot-YYYYMMDD` GitHub release) —
  rerun `apple-docs setup` to pick it up.
- The **next standalone binary build** (`release-binaries.yml`) —
  re-download from the latest release.
- A `git pull` for source installs.

If you are running an older snapshot or binary, the supported remedy is
to upgrade to the latest. No fixes are backported to earlier snapshot
tags.

## Scope

In scope:

- The CLI binary (`apple-docs`) and any flag combination it accepts.
- The web server (`apple-docs web serve`) including all `/api/*` and
  static document routes.
- The MCP HTTP server (`apple-docs mcp serve`) and every registered
  tool.
- Snapshot install (`apple-docs setup`) and the snapshot tarball
  pipeline.
- Storage (`apple-docs storage *`), including any data-dir traversal
  vectors.
- The Caddy / launchd / watchdog scripts under `ops/`.

Out of scope:

- Third-party dependency advisories. Tracked separately via
  `bun audit` (blocking in CI; see `.github/workflows/ci.yml`). If a
  transitive advisory affects this project specifically, please file
  it as a vulnerability so it can be pinned or overridden.
- Issues that require an attacker to already have shell access on the
  host (for example, modifying `data/` directly).
- Brute-force or DoS reports without an amplification or work-bound bug.

## Hardened defaults

apple-docs is designed to remain publicly reachable, so the defenses
below bound the work an unauthenticated request can do rather than
gating access.

### Request boundary

- **Per-IP token-bucket rate limit.** Default 60 req/s burst 120, with
  an LRU-bounded bucket table (4096 IPs max) so a botnet flood cannot
  exhaust memory. `X-Forwarded-For` is honoured when a reverse proxy
  is in front.
- **Stricter on-demand cold-path gate.** Requests under `/docs/*` that
  miss the corpus and would trigger an upstream Apple fetch are
  additionally gated at 5 req/min per IP, with a 24-hour 1024-entry
  negative cache so 404s from Apple are not replayed.
- **1 MiB body cap on MCP HTTP.** Both the `Content-Length` header and
  the streaming reader are bounded; the stream is cancelled on
  overflow.
- **Browser `Origin` default-deny on MCP HTTP.** Loopback origins
  (`http(s)://localhost`, `127.0.0.1`, `[::1]` on any port) are
  exempt; native MCP clients that send no `Origin` header are allowed;
  everything else requires an explicit `--allow-origin` entry.
- **Request-ID validation.** Inbound `X-Request-Id` headers are
  accepted only if they match `[A-Za-z0-9._:+/=-]{1,128}`; otherwise a
  UUID is minted server-side. Prevents log-injection via the
  correlation header.
- **MCP HTTP response headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Cross-Origin-Resource-Policy:
  same-origin`, and a `Permissions-Policy` that disables geolocation,
  camera, microphone, and similar capabilities.

### Concurrency bounding

- **MCP heavy-tool semaphore.** `search_docs`, `read_doc`, `browse`,
  and the rendering tools share an 8-slot semaphore with a 64-entry
  waiter queue (defaults; configurable via
  `APPLE_DOCS_MCP_CONCURRENCY` and `APPLE_DOCS_MCP_QUEUE`). Overflow
  returns JSON-RPC error `-32003` with HTTP 503.
- **Reader-pool backpressure rejects.** Web and MCP reader pools both
  emit per-pool backpressure-reject counters; when surfaced via
  `/metrics`, sustained rejects indicate a saturated DB or runaway
  query path.

### Storage and supply chain

- **Snapshot tarball validator** rejects symlinks, hardlinks, absolute
  paths, and traversal members before extraction. Both `.tar.gz` and
  `.7z` archives go through the same gate. `.sha256` sidecar is
  mandatory for GitHub releases and optional-with-warning for local
  `--archive` paths (the operator is trusted at that boundary but the
  warning surfaces missing sidecars).
- **Native-spawn deadlines.** Every Swift, `hdiutil`, `tar`, and `7z`
  subprocess is wrapped by `src/lib/spawn-with-deadline.js` with a
  10-second default deadline (bumped to multi-minute for archive
  extraction) and a 64 KiB stderr cap. On timeout the process is
  SIGKILL'd and the captured stderr prefix is included in the thrown
  `SpawnTimeoutError`.
- **Storage-key validator.** Every key written under `dataDir` is
  validated to reject traversal segments (`..`), absolute roots
  (`/`, `~`, Windows `C:\`), backslash separators, and embedded NUL
  bytes. After resolution the absolute path is asserted to live under
  the canonicalized `dataDir` (belt-and-braces against regex bugs and
  Unicode normalization corner cases).

### Upstream traffic

- **Fetch retry budget.** Outbound fetches honour `Retry-After` and
  GitHub's `x-ratelimit-reset` headers and cap cumulative backoff per
  attempt so a misbehaving upstream cannot park a request
  indefinitely.

### Logging

- **Secret redaction.** Structured log payloads are walked at emission
  time and values for keys matching `token`, `secret`, `authorization`,
  `cookie`, `password`, `api[_-]?key`, or `bearer` are replaced with
  `<redacted>` (case-insensitive, depth-capped at 8).

If you find a way around any of these, please report it via the
channel above.
