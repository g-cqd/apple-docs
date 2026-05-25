# Installation paths

Three supported ways to install apple-docs. Pick the one that matches
your intent. Every path ends with a verification block — run it before
declaring the install done.

| Path | When to use | Output |
| --- | --- | --- |
| [Dev install](#dev-install) | Hacking on the source, running tests, contributing | Linked `apple-docs` and `apple-docs-mcp` binaries on `~/.bun/bin` |
| [Standalone binary](#standalone-binary) | CLI / personal MCP server with no Bun runtime on the host | One executable file |
| [Production self-host](#production-self-host) | Publicly reachable MCP HTTP server behind Caddy and cloudflared | launchd-managed Bun servers + Caddy + cloudflared |

All three require Bun **only for build or install**. The standalone
binary and the production launchd plists run Bun internally; operators
do not need it on their interactive `PATH` afterwards.

> [!NOTE]
> **Linux SF Symbol parity.** SF Symbol pre-rendering needs the macOS
> SF Symbols system bundle, so `apple-docs sync` on Linux produces an
> empty `resources/symbols/` directory. Linux installs should use the
> snapshot path (`apple-docs setup`) — every published snapshot ships
> the full pre-rendered SVG matrix and works offline. PNG variants
> still need `rsvg-convert` (librsvg) on the host at request time; see
> [Self-hosting → Snapshot consumer requirements](self-hosting.md#snapshot-consumer-requirements).

## Prerequisites

- macOS 13+ on Apple Silicon or Intel, or Linux x64 / arm64 with Bun 1.1+.
- `git`, `curl`, `unzip`.
- For the production path: `caddy` (`brew install caddy` on macOS,
  package manager on Linux), `cloudflared`, and a Cloudflare account
  with a Tunnel configured.

Install Bun if it is not on `PATH`:

```bash
curl -fsSL https://bun.sh/install | bash
# Or via Homebrew: brew install oven-sh/bun/bun
```

Confirm: `bun --version` reports 1.0 or later.

## Dev install

For working on the source. A single one-shot script installs every
runtime and test prerequisite, then links the CLI binaries onto
`~/.bun/bin`.

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup
```

`bun run dev:setup` is idempotent. It runs:

| Step | What it installs | How |
| --- | --- | --- |
| `bun install` | npm dependencies | Bun's package manager |
| `bun link` | `apple-docs` and `apple-docs-mcp` on `~/.bun/bin` | Bun's link symlinks |
| 7zip CLI | Unblocks the archive tests | `brew install sevenzip` on macOS; manual `apt`, `dnf`, or `pacman` on Linux |
| Python `fontTools` + `brotli` | Unblocks the font-subset tests (brotli is fontTools' WOFF2 codec) | `pip3 install --user fontTools brotli` |
| Playwright Chromium | Unblocks the browser worker test | `bunx playwright install chromium` |

`bun link` installs two binaries at `~/.bun/bin`:

- `apple-docs` — full CLI (search / read / browse / sync / mcp / web).
- `apple-docs-mcp` — back-compatible alias for `apple-docs mcp start`.

Make sure `~/.bun/bin` is on your interactive `PATH`. Bun's installer
appends it to `~/.bashrc` or `~/.zshrc`; reload your shell or `source`
the file.

Populate the corpus:

```bash
# Fast path: install the latest snapshot.
apple-docs setup

# OR full crawl from scratch.
apple-docs sync --use-git-auth
```

Run the test suite:

```bash
bun run ci        # lint + typecheck + tests
bun run audit     # adds knip + jscpd + file-size + coverage
```

Live documentation preview:

```bash
bun run docs:dev      # serves docs/ for local editing
bun run docs:build    # static site at docs/.vitepress/dist/
bun run docs:preview  # serves the built site for verification
```

## Standalone binary

A single-file Bun-compiled executable. Use this for personal CLI or MCP
use when a full Bun toolchain on the host is undesirable.

Build it from a dev checkout, or download from a GitHub release once
the `release-binaries.yml` workflow has attached one:

```bash
# From a dev checkout:
bun run build:cli         # current host: dist/apple-docs
bun run build:cli:all     # cross-compile: darwin-arm64 + linux-x64 + linux-arm64
```

Move the binary onto your `PATH`:

```bash
install dist/apple-docs /usr/local/bin/apple-docs
apple-docs setup
```

The binary embeds everything except the corpus. `APPLE_DOCS_HOME`
points it at a data directory (default `~/.apple-docs`).

Verify:

```bash
apple-docs --help
apple-docs search NavigationStack --json
apple-docs status --json
```

## Production self-host

Runs the reference deployment topology: Bun web and MCP servers under
launchd, Caddy as the loopback reverse proxy, cloudflared as the public
tunnel.

The full deployment reference is [Self-hosting](/self-hosting); this
section is the install-time checklist.

### 1. Clone and install dependencies

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
```

Do **not** run `bun link` for a production install. Production uses the
`ops/bin/*.sh` shims, which locate Bun via `$BUN_BIN`, `~/.bun/bin`,
and Homebrew prefixes. Linking is unnecessary and adds a version-drift
maintenance path between a user-installed `~/.bun/bin/apple-docs` and
the launchd-managed Bun process.

### 2. Configure `ops/.env`

```bash
cp ops/.env.example ops/.env
$EDITOR ops/.env
```

Set at minimum (variable names match `ops/.env.example` exactly):

- `REPO_DIR` — absolute path to this checkout.
- `DATA_DIR` — corpus location (`apple-docs setup` writes here).
- `WEB_PORT` and `MCP_PORT` — Caddy's loopback listeners (default
  `3030` / `3031`).
- `WEB_BACKEND_PORT` and `MCP_BACKEND_PORT` — Bun's loopback listeners
  behind Caddy (default `3130` / `3131`).
- `PUBLIC_WEB_HOST`, `PUBLIC_MCP_HOST` — your public hostnames.
- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID` — optional, only for
  edge cache purges after a deploy.

See `ops/.env.example` for the full list with comments.

### 3. Render templates and install daemons

```bash
ops/bin/render-all.sh
ops/bin/install-daemons.sh    # one-time: sudoers + launchd plists
```

`install-daemons.sh` is the only step that requires `sudo`. It writes a
sudoers drop-in so subsequent `launchctl` operations do not prompt.

### 4. Populate the corpus

```bash
ops/bin/apple-docs setup
# OR
ops/bin/apple-docs sync
```

### 5. Start services

```bash
ops/bin/apple-docs-ops service start all
```

Verify with the block below.

### 6. Cloudflare tunnel

Configure cloudflared per `ops/cloudflared/README.md` (one tunnel per
public host). Once the tunnel is up, public hosts resolve to Caddy on
the loopback ports, and Caddy forwards to the Bun upstreams.

### Verification

```bash
# Local liveness (Caddy loopback ports).
curl -sf http://127.0.0.1:${WEB_PORT:-3030}/healthz
curl -sf http://127.0.0.1:${MCP_PORT:-3031}/readyz | jq

# Internal Bun upstream (bypasses Caddy — useful if Caddy is the suspect).
curl -sf http://127.0.0.1:${MCP_BACKEND_PORT:-3131}/readyz | jq

# Public reach (via cloudflared).
curl -sf https://${PUBLIC_MCP_HOST}/readyz | jq

# Smoke test the install end-to-end.
ops/bin/smoke-test.sh
```

## Configuring an MCP client

Use the public instance you stood up, or the project's reference
instance at `https://apple-docs-mcp.everest.mt/mcp`:

```bash
# Claude Code, HTTP transport.
claude mcp add -s user --transport http apple-docs https://<public-host>/mcp

# Codex CLI (uses the mcp-remote stdio bridge).
codex mcp add apple-docs -- bunx mcp-remote https://<public-host>/mcp

# Print installer snippets for other clients.
apple-docs mcp install --http https://<public-host>/mcp
```

## Uninstall

Dev install:

```bash
bun unlink            # removes ~/.bun/bin/apple-docs symlinks
rm -rf ~/.apple-docs  # removes the corpus
```

Standalone:

```bash
rm /usr/local/bin/apple-docs
rm -rf ~/.apple-docs
```

Production:

```bash
ops/bin/apple-docs-ops service stop all
sudo launchctl unload /Library/LaunchDaemons/com.apple-docs.*.plist
sudo rm /Library/LaunchDaemons/com.apple-docs.*.plist
sudo rm /etc/sudoers.d/apple-docs
rm -rf "$DATA_DIR"
```
