# ops/ — reference self-hosted deployment

This directory is a working example of one way to run `apple-docs` as a
long-lived service on a macOS host, fronted by Caddy and exposed through
Cloudflare Tunnel. It is a *starter* — review every script before you run
anything with `sudo`, and treat the defaults as defaults, not gospel.

For the overall architecture and alternatives (tailscale, bare ngrok, a Linux
box, etc.) see [`../docs/self-hosting.md`](../docs/self-hosting.md). This
directory just templates the specific pieces used on the maintainer's box.

## Shape

```
ops/
├── .env.example            # every operator-specific value, documented
├── bin/                    # entrypoints (apple-docs-ops dispatches the rest)
├── lib/                    # env.sh (loads .env), render.sh (envsubst helper)
├── launchd/*.tpl           # system LaunchDaemons + sudoers drop-in
├── caddy/Caddyfile.tpl     # reverse proxy terminating TLS on localhost
└── cloudflared/*.tpl       # two tunnels: one for the web UI, one for MCP
```

Nothing inside `ops/` is imported by the runtime. You can delete the whole
directory and `apple-docs` still works.

## One-time setup

```sh
cd ops
cp .env.example .env
$EDITOR .env                       # fill in every value
./bin/render-all.sh                # envsubst every .tpl -> sibling file
./bin/install-daemons.sh           # copies rendered plists into /Library/LaunchDaemons
```

`install-daemons.sh` installs the sudoers drop-in first (via `visudo -cf` for
validation, then `install -m 0440`) so the remaining `launchctl bootstrap`
calls work without a password prompt. It only grants `launchctl` rights for
the five labels in `launchd/sudoers.apple-docs-launchctl.tpl` — nothing more.

## Day-to-day

```sh
./bin/apple-docs-ops status        # show launchd status for all five daemons
./bin/apple-docs-ops restart web   # kickstart just one
./bin/deploy-update.sh             # git pull + bun install + restart web/mcp
./bin/smoke-test.sh                # curl the public endpoints
```

## Not shipped here

- TLS certificates — Cloudflare terminates TLS in front of the tunnel, and
  Caddy runs HTTP-only on loopback. If you swap Cloudflare for a plain public
  IP, add a real ACME block in `caddy/Caddyfile.tpl`.
- Backups of `$DATA_DIR` — `apple-docs` can rebuild its SQLite DB from
  scratch, but a daily `rsync` of `~/.apple-docs` is cheap insurance.
- Monitoring — `/healthz` is exposed on both the web and MCP backends;
  point your uptime tool at `https://${PUBLIC_*_HOST}/healthz`.

## Template variables

`ops/.env.example` is the complete list. Derived values (`LABEL_PROXY`,
`LABEL_WEB`, …) are computed in `ops/lib/env.sh` and do not need to be set
by hand.
