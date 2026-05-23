# Security Policy

## Reporting a vulnerability

If you discover a security issue in **apple-docs** (CLI, web server, or MCP
HTTP server), please report it privately rather than opening a public issue.

**Preferred channel:** open a [GitHub private security advisory](https://github.com/g-cqd/apple-docs/security/advisories/new)
on this repository. GitHub notifies the maintainer; the discussion stays
private until a fix and disclosure timeline are agreed.

If GitHub advisories are unavailable to you, send an email to the address
listed under "Contact" on the GitHub profile of the repository owner. Use
PGP if you can; the maintainer will respond with a key on first contact if
the message is unencrypted.

Please include:

- A description of the vulnerability and its impact.
- Reproduction steps (a minimal proof-of-concept is ideal).
- The version (`apple-docs --version`) or commit SHA you observed it on.
- Any mitigations you've already identified.

We aim to respond within **3 business days** with an acknowledgement and
an expected timeline. Coordinated disclosure is preferred; we'll credit
the reporter in the release notes unless asked otherwise.

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
- The MCP HTTP server (`apple-docs mcp serve`) and every registered tool.
- Snapshot install (`apple-docs setup`) and the snapshot tarball pipeline.
- Storage (`apple-docs storage *`), including any data-dir traversal
  vectors.
- The Caddy / launchd / watchdog scripts under `ops/`.

Out of scope:

- Third-party dependency advisories — these are tracked separately via
  `bun audit` (blocking in CI; see `.github/workflows/ci.yml`). If you
  believe a transitive advisory affects this project specifically, please
  file it as a vulnerability so we can pin or override.
- Issues that require an attacker to already have shell access on the
  host (e.g. modifying `data/` directly).
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
- **Browser `Origin` default-deny on MCP HTTP** (loopback exempt;
  no-`Origin` native clients pass).
- **Request-ID validation.** Inbound `X-Request-Id` headers are
  accepted only if they match `[A-Za-z0-9._:+/=-]{1,128}`; otherwise a
  UUID is minted server-side. Prevents log-injection via the
  correlation header.
- **MCP HTTP response headers.** `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store`, `Cross-Origin-Resource-Policy:
  same-origin`, plus a `Permissions-Policy` disabling geolocation,
  camera, microphone, and similar capabilities.

### Concurrency bounding

- **MCP heavy-tool semaphore.** `search_docs`, `read_doc`, `browse`,
  and the rendering tools share an 8-slot semaphore with a 64-entry
  waiter queue (defaults; configurable). Overflow returns JSON-RPC
  error `-32003` with HTTP 503.
- **Reader-pool backpressure rejects.** Both surfaces emit per-pool
  backpressure-reject counters via `/metrics`; sustained rejects
  indicate a saturated DB or runaway query path.

### Storage and supply chain

- **Snapshot tarball validator** rejects symlinks, hardlinks, absolute
  paths, and traversal members before extraction. `.sha256` sidecar is
  mandatory for GitHub releases and optional-with-warning for local
  `--archive` paths.
- **Native-spawn deadlines** (Swift, `hdiutil`, `tar`, `7z`) with a
  default deadline and a 64 KiB stderr cap. On timeout the process is
  SIGKILL'd and the captured stderr prefix is included in the thrown
  error.
- **Storage-key validator** rejects traversal, absolute, embedded-NUL,
  and backslash-bearing keys, and asserts the resolved path lives
  under `dataDir` after canonicalization.

### Upstream traffic

- **Fetch retry budget.** Outbound fetches honour `Retry-After` and
  GitHub's `x-ratelimit-reset` headers and cap cumulative backoff so
  a misbehaving upstream cannot park a request indefinitely.

### Logging

- **Secret redaction.** Structured log payloads are walked at emission
  and values for keys matching `token`, `secret`, `authorization`,
  `cookie`, `password`, `api[_-]?key`, or `bearer` are replaced with
  `<redacted>` (case-insensitive, depth-capped).

If you find a way around any of these, please report it via the channel
above.
