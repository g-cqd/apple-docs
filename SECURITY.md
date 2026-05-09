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

The project ships from `main`. The most recent **two minor versions** on
the `main` branch receive security fixes; older versions get advisories
in the changelog but no backport.

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
gating access:

- Per-IP token-bucket rate limit (60 req/s burst 120; 5 req/min on
  on-demand doc fetches that trigger upstream traffic).
- 1 MiB body cap on MCP HTTP; streaming reads abort on overflow.
- Browser `Origin` default-deny on MCP HTTP (loopback exempt; no-Origin
  native clients pass).
- Snapshot tarball validator rejects symlinks, hardlinks, absolute paths,
  and traversal members; mandatory `.sha256` checksum.
- Native-spawn (Swift / hdiutil / tar) deadlines + bounded stderr capture.
- Storage-key validator rejects traversal/absolute/embedded-NUL keys
  and asserts the resolved path lives under `dataDir`.

If you find a way around any of these, please report it via the channel
above.
