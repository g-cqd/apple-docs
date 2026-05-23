# Installation paths

Three supported ways to install apple-docs. Pick the one that matches
your intent. Every path ends with a verification block — run it before
declaring the install done.

| Path | When to use | Output |
| --- | --- | --- |
| [Dev install](#dev-install) | Hacking on the source, running tests, contributing | Linked `apple-docs` / `apple-docs-mcp` binaries on `~/.bun/bin` |
| [Standalone binary](#standalone-binary) | Use as a CLI / personal MCP server with no Bun runtime | Single ~78 MB executable |
| [Production self-host](#production-self-host) | Run a publicly-reachable MCP HTTP server (the topology behind the public hosted instance) | Caddy + cloudflared + launchd-managed Bun servers |

All three paths require Bun **only for build/install**. The standalone
binary and the production launchd plists run Bun internally but
operators don't need it on their interactive PATH afterwards.

## Prerequisites

- macOS 13+ on Apple Silicon or Intel; or Linux x64/arm64 with Bun 1.0+.
- `git`, `curl`, `unzip`.
- For the production path: `caddy` (`brew install caddy` on macOS,
  package manager on Linux), `cloudflared`, and a Cloudflare account
  with a Tunnel configured.

Install Bun once if it isn't already on PATH:

```bash
curl -fsSL https://bun.sh/install | bash
# Or via Homebrew: brew install oven-sh/bun/bun
```

Confirm: `bun --version` should print 1.0 or later.

## Dev install

For working on the source. Single one-shot script — installs every
runtime + test prerequisite the project uses, then links the CLI
binaries onto `~/.bun/bin`.

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup
```

`bun run dev:setup` is idempotent — re-running is safe. It executes:

| Step | What it installs | How |
| --- | --- | --- |
| `bun install` | npm dependencies | Bun's package manager |
| `bun link` | `apple-docs` + `apple-docs-mcp` on `~/.bun/bin` | Bun's link symlinks |
| 7zip CLI | Unblocks the 11 archive tests | `brew install sevenzip` on macOS; manual `apt`/`dnf`/`pacman` on Linux |
| Python `fontTools` | Unblocks the 12 font-subset tests | `pip3 install --user fontTools` |
| Playwright Chromium | Unblocks the browser worker test | `bunx playwright install chromium` |

`bun link` installs two binaries at `~/.bun/bin`:
- `apple-docs` — full CLI (search / read / browse / sync / mcp / web)
- `apple-docs-mcp` — back-compat alias for `apple-docs mcp start`

Make sure `~/.bun/bin` is on your interactive PATH. Bun's installer
appends it to `~/.bashrc` / `~/.zshrc`; reload your shell or `source`
the file.

Populate the corpus:

```bash
# Fast: install the latest weekly snapshot (≈60 s; ~6 GB on disk).
apple-docs setup

# OR slow: crawl from scratch (~25 min on Apple Silicon; same disk).
apple-docs sync --use-git-auth
```

Run the test suite:

```bash
bun run ci        # lint + typecheck + tests (~40 s)
bun run audit     # adds knip + jscpd + file-size + coverage
```

After `dev:setup` completes, the previously-gated tests run end-to-end
against your local toolchain (only the headless-browser worker test
still skips if the corpus is empty).

Live documentation preview:

```bash
bun run docs:dev      # serves docs/ on http://localhost:5173
bun run docs:build    # static site at docs/.vitepress/dist/
bun run docs:preview  # serves the built site for verification
```

## Standalone binary

A single-file Bun-compiled executable. Use this for personal CLI / MCP
use when you don't want a full Bun toolchain on the host.

Build it from a dev checkout (or download from a GitHub release once
the `release-binaries.yml` workflow has attached one):

```bash
# From a dev checkout:
bun run build:cli                  # current host: dist/apple-docs
bun run build:cli:all              # cross-compile: darwin-arm64 + linux-x64 + linux-arm64
```

Result: `dist/apple-docs` (≈78 MB). Move it onto your PATH:

```bash
install dist/apple-docs /usr/local/bin/apple-docs
apple-docs setup            # populate the corpus
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

Runs the public-instance topology — Bun web + MCP servers under
launchd, Caddy as the loopback reverse proxy, cloudflared as the public
tunnel. This is what backs the project's reference public instance.

The full deployment guide is [`docs/self-hosting.md`](self-hosting.md);
this is the install-time checklist.

### 1. Clone + dependencies

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun install
```

Do NOT `bun link` for a production install — production uses the
`ops/bin/*.sh` shims, which find Bun via `$BUN_BIN` / `~/.bun/bin` /
homebrew prefixes. Linking is unnecessary and adds a maintenance path
(version drift between user-installed `~/.bun/bin/apple-docs` and the
launchd-managed Bun process).

### 2. Configure `ops/.env`

```bash
cp ops/.env.example ops/.env
$EDITOR ops/.env
```

Set at minimum:
- `APPLE_DOCS_REPO_DIR` — absolute path to this checkout.
- `APPLE_DOCS_DATA_DIR` — corpus location (`apple-docs setup` writes here).
- `APPLE_DOCS_PROXY_WEB_PORT` / `APPLE_DOCS_PROXY_MCP_PORT` — Caddy's
  loopback listeners (defaults 3030 / 3031).
- `APPLE_DOCS_BUN_WEB_PORT` / `APPLE_DOCS_BUN_MCP_PORT` — Bun's
  loopback listeners behind Caddy (defaults 3130 / 3131).
- `CF_TOKEN`, `CF_ZONE_ID` — for cache purges.
- `PUBLIC_WEB_HOST`, `PUBLIC_MCP_HOST` — your public hostnames.

See `ops/.env.example` for the full list with comments.

### 3. Render templates + install daemons

```bash
ops/bin/render-all.sh
ops/bin/install-daemons.sh    # one-time: sudoers + launchd plists
```

`install-daemons.sh` is the only step that requires `sudo`. It writes a
sudoers drop-in so subsequent `launchctl` operations don't prompt.

### 4. Populate the corpus

```bash
ops/bin/apple-docs setup       # weekly snapshot (~60 s)
# OR
ops/bin/apple-docs sync        # full crawl (~25 min)
```

### 5. Start services

```bash
ops/bin/apple-docs-ops service start all
```

Verify with the verification block below.

### 6. Cloudflare tunnel

Configure cloudflared per `ops/cloudflared/README.md` (one tunnel per
public host). Once the tunnel is up, the public hosts resolve to Caddy
on the loopback ports, and Caddy forwards to the Bun upstreams.

### Verification

```bash
# Local liveness (Caddy loopback ports).
curl -sf http://127.0.0.1:${APPLE_DOCS_PROXY_WEB_PORT:-3030}/healthz
curl -sf http://127.0.0.1:${APPLE_DOCS_PROXY_MCP_PORT:-3031}/readyz | jq

# Internal Bun upstream (bypasses Caddy — useful if Caddy is the suspect).
curl -sf http://127.0.0.1:${APPLE_DOCS_BUN_MCP_PORT:-3131}/readyz | jq

# Public reach (via cloudflared).
curl -sf https://${PUBLIC_MCP_HOST}/readyz | jq

# Smoke test the install end-to-end.
ops/bin/smoke-test.sh
```

## Configuring an MCP client

Use the public instance you just stood up, or the project's reference
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
rm -rf "$APPLE_DOCS_DATA_DIR"
```
