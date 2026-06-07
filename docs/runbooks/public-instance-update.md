# Public-instance update runbook

Steps to roll a new snapshot to a self-hosted public instance after a
weekly (or manual) `snapshot.yml` GitHub Actions run.

This runbook assumes the standard `ops/` topology described in
[Self-hosting](/self-hosting):

```mermaid
flowchart LR
  TUN["cloudflared tunnel"]
  CADDY["Caddy (apple-docs.proxy daemon)"]
  WEB["Bun web server"]
  MCP["Bun mcp server"]
  WD["watchdog (apple-docs.watchdog daemon)"]

  TUN -- "loopback" --> CADDY
  CADDY -- "health-gated /healthz" --> WEB
  CADDY -- "health-gated /healthz" --> MCP
  WD -. "kickstarts on probe fail" .-> WEB
  WD -. "kickstarts on probe fail" .-> MCP
```

All six daemons run as **system LaunchDaemons** in `/Library/LaunchDaemons`
(`apple-docs.{web,mcp,proxy,watchdog}` + `cloudflared.apple-docs{,-mcp}`),
installed via `apple-docs-ops install`. Caddy is supervised by the
`apple-docs.proxy` daemon (the ops `proxy run` verb just execs `caddy run`).

It uses the `ops/bin/*.sh` shims so commands work under non-interactive
SSH without depending on the operator's PATH. Replace `<host>` with the
actual SSH target; replace `<repo>` with the repo checkout path declared
in your `ops/.env`.

## Pre-flight

1. Confirm the latest `snapshot.yml` workflow run succeeded — the
   determinism gate (re-build + sha256 diff) must be green. A failed
   determinism gate is a **do not deploy** signal; investigate first.
2. Note the snapshot tag (typically `snapshot-YYYYMMDD`) from the
   GitHub release page.

## Update

On the host that runs the public instance:

```bash
ssh <host>
cd <repo>

# Optional: render templates if .env changed.
ops/bin/render-all.sh

# Pull the latest GitHub release snapshot. The script auto-detects
# the newest published `snapshot-YYYYMMDD` tag, verifies its .sha256
# sidecar, and runs `apple-docs setup --force`. Use --force/-f or
# FORCE_PULL=1 to re-apply a tag that's already installed.
ops/bin/pull-snapshot.sh

# Atomic deploy: git pull, render templates, optional corpus refresh,
# incremental static-site rebuild, launchctl kickstart of web + MCP,
# Cloudflare edge purge, smoke test.
ops/bin/deploy-update.sh

# Smoke-test the running instance.
ops/bin/smoke-test.sh
```

`deploy-update.sh` is the all-in-one: it keeps the previous web and MCP
daemons online while it pulls + renders + refreshes the corpus + rebuilds
the static site, then cuts over by `launchctl kickstart`-ing the daemons in
order — **web → mcp → (3 s pause) → watchdog**. The pause lets the watchdog
re-probe the fresh backends instead of the just-killed ones. Caddy's
health-gated upstream (`/healthz`, 2 passes / 3 fails) absorbs the cut-over.

Because `deploy-update.sh` already refreshes the corpus itself (it
auto-detects a newer GitHub snapshot tag vs `ops/state/applied-snapshot`
and runs `pull-snapshot` when one exists, else an incremental host `sync`),
the standalone `pull-snapshot.sh` / `render-all.sh` steps above are only for
a **corpus-only** or **config-only** refresh. For a normal roll you can run
`deploy-update.sh` alone. Force snapshot mode with `USE_SNAPSHOT=1` (or crawl
mode with `USE_SNAPSHOT=0`). If a deploy changed any `launchd/*.tpl`, the
run warns about plist drift — `kickstart` won't pick up new plists, so run
`apple-docs-ops install` to reinstall them.

If you need to install a **specific** older snapshot tag (e.g. the one
you were on before today), download the asset by hand and feed it to
`setup --archive`:

```bash
gh release download <tag> --repo g-cqd/apple-docs \
  --pattern 'apple-docs-full-*.tar.gz' \
  --pattern 'apple-docs-full-*.tar.gz.sha256'
ops/bin/apple-docs setup --archive apple-docs-full-<tag>.tar.gz --force
ops/bin/deploy-update.sh
```

## Verification

```bash
# Public liveness + readiness (replace with your hostname).
curl -sf https://<public-host>/healthz
curl -sf https://<public-host>/readyz

# Tool call via the MCP HTTP endpoint.
apple-docs mcp install --http https://<public-host>/mcp
# Use the printed config in Claude Code / Codex, then run a known query.

# Status freshness — should report the new snapshot tag. Uses the
# ops/bin/apple-docs shim so it works under non-interactive SSH.
ssh <host> '<repo>/ops/bin/apple-docs status --advanced --json' \
  | jq '.lastSync, .freshness'

# Internal probes (loopback, via the local Caddy + Bun chain).
ssh <host> "curl -sf http://127.0.0.1:\${MCP_PORT:-3031}/readyz | jq"
```

## CDN cache purge

`deploy-update.sh` calls `ops/bin/cf-purge.sh` as its last step (no
flags). The script issues a single Cloudflare `purge_everything`
against the configured zone and returns. If `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ZONE_ID` aren't set in `ops/.env`, the purge step warns
and exits 0 — the deploy is still considered successful.

The site's Cache Rules already advertise `stale-while-updating`, so
end-users see the old cached object while Cloudflare revalidates
against the origin. There is no built-in warmup step. If you want to
pre-warm specific endpoints after a purge, drive `curl` against them
by hand:

```bash
for path in / /docs/swiftui/ /api/search?q=NavigationStack; do
  curl -sI "https://${PUBLIC_WEB_HOST}${path}" >/dev/null
done
```

## Rollback

There is no in-place revert. If `/readyz` or
`ops/bin/smoke-test.sh` fails after a deploy, recover by installing the
previous snapshot tag from scratch:

```bash
gh release download <previous-tag> --repo g-cqd/apple-docs \
  --pattern 'apple-docs-full-*.tar.gz' \
  --pattern 'apple-docs-full-*.tar.gz.sha256'
ops/bin/apple-docs setup --archive apple-docs-full-<previous-tag>.tar.gz --force
ops/bin/deploy-update.sh
ops/bin/smoke-test.sh
```

`apple-docs setup --force` wipes the `apple-docs.db` and extracts the
new archive into the same `DATA_DIR`. The reverse-proxy and tunnel
daemons stay up across the swap.

## Related

- `snapshot.yml` workflow — produces the artefacts.
- `release-binaries.yml` workflow — attaches standalone CLI binaries.
- [Installing](/installing) — install paths (dev / standalone /
  production).
- [Self-hosting](/self-hosting) — full deployment reference (launchd,
  Caddy, cloudflared).
- [Security](/security) — snapshot validation and hardened defaults.
