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
- The **next standalone binary build** (attached to each snapshot
  release by `snapshot.yml`) — re-download from the latest release.
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
- **Repo-policy alerts** surfaced by OpenSSF Scorecard. Status of each
  as of the most recent counter-audit:
  - **Branch-Protection** — `main` is now protected via the GitHub API:
    no force-push, no deletion (`gh api PUT
    repos/g-cqd/apple-docs/branches/main/protection`). Required
    status checks and required reviews are deliberately *not* enabled
    so the solo-maintainer workflow keeps working. Scorecard will
    grade this somewhere between "partial" and "fail" depending on the
    cycle's exact criteria; the deliberate trade-off is documented
    here rather than left implicit.
  - **Code-Review** — a solo-maintained project cannot satisfy
    Scorecard's "every commit reviewed by another human" criterion
    without splitting maintainers. The alert remains open; reviewers
    should treat it as a known governance constraint of this
    repository.
  - **Maintained** — passive; auto-clears once recent commit activity
    is reflected in the next Scorecard run.
  - **CII-Best-Practices** — requires registration at
    bestpractices.coreinfrastructure.org. Not a code change; the
    maintainer can register at their discretion.
  - **Fuzzing** — requires OSS-Fuzz / ClusterFuzzLite integration.
    Tracked as out-of-scope for this codebase until a meaningful
    fuzzing target exists.

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
- **1 MB body cap on MCP HTTP** (`DEFAULT_MAX_BODY_BYTES = 1_000_000`
  in `src/lib/http-body.js`). Both the `Content-Length` header and the
  streaming reader are bounded; the stream is cancelled on overflow.
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
  paths, and traversal members before extraction. `.tar.zst`, `.tar.gz`,
  and `.7z` archives go through the same gate. `.sha256` sidecar is
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

### Web Worker boundary

- **Origin-validated `base` argument.** The browser-side search Web
  Worker (`src/web/worker/search-worker.js`) accepts an `init`
  postMessage carrying a `base` URL used for `/data/search/*` fetches.
  The worker rejects any base whose origin differs from
  `self.location.origin`, so a same-origin script cannot redirect the
  worker's index-load fetches to an external host. Empty string and
  root-relative paths pass through as before.

### Logging

- **Secret redaction (in-process).** Structured log payloads are
  walked at emission time and values for keys matching `token`,
  `secret`, `authorization`, `cookie`, `password`, `api[_-]?key`, or
  `bearer` are replaced with `<redacted>` (case-insensitive,
  depth-capped at 8). See `src/lib/logger.js`.
- **Secret redaction (ops layer).** `ops/lib/logger.js` mirrors the
  same redaction over free-form subprocess output (curl, gh, cf-purge)
  so HTTP Authorization headers / Bearer tokens / query-string
  credentials never reach the on-disk deploy log.

### Subprocess / shell hardening

- **No shell interpolation.** Native-binary spawns
  (`tar`, `gzip`, `hdiutil`, `7zz`, `swift`, `sips`, `rsvg-convert`)
  always go through `Bun.spawn` / `node:child_process.spawn` with an
  argv array, never `bash -c`. The tar.gz archive pipeline pipes
  tar's stdout through `node:zlib.createGzip()` in-process so no
  shell layer participates in the build.
- **Pinned GitHub Actions.** Every workflow `uses:` reference is
  pinned to a full commit SHA with a trailing version comment
  (`actions/checkout@93cb6efe…  # v5`). Resolves OpenSSF
  Scorecard's Pinned-Dependencies check and prevents supply-chain
  hijacks via tag movement.

If you find a way around any of these, please report it via the
channel above.
