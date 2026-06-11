# Native-embed soak rollout (RFC 0002 phase 5)

One-time runbook to start the native-by-default soak on the beta instance
(mm18). Prerequisite: a fresh beta release must exist — the previous beta's
dylib bundle predates the `ad_embed_*` exports.

## Step 1 — publish the beta (LOCAL dev machine)

```bash
cd ~/Developer/ongoing/javascript/apple-docs
bun scripts/publish-beta-snapshot.mjs
```

~20–40 min. The build itself runs native-embed via the dev dylib
(default-on) and attaches the new darwin-universal bundle to the release.

## Step 2 — roll the instance (ON mm18)

```bash
bash -lc '
set -e
cd ~/Developer/apple-docs

# pin the soak env (explicit csv survives future default changes)
sed -i "" "s/^#* *APPLE_DOCS_NATIVE=.*/APPLE_DOCS_NATIVE=fusion,archive,embed/" ops/.env
grep "^APPLE_DOCS_NATIVE=" ops/.env

# deploy new code (git ff-pull + bun install + render-all + restart)
bun ops/cli.js deploy-update

# re-install rendered plists (idempotent; picks up the env change)
sudo bin/apple-docs-ops install 2>/dev/null || sudo ops/bin/apple-docs-ops install

# pull the fresh beta snapshot + the NEW native bundle
# (setup --force --native --beta; pre-generates matrix-v1.admx; restarts)
bun ops/cli.js pull-snapshot

# verify
curl -fsS http://127.0.0.1:8080/healthz && echo " local healthz OK"
ls -la ~/.apple-docs/resources/models/minishlab/potion-retrieval-32M/matrix-v1.admx
APPLE_DOCS_LOG_LEVEL=info bun cli.js search "swiftui animation" 2>&1 | grep -E "served by"
'
```

Expected: healthz 200, `matrix-v1.admx` present (~129 MB), and
`embed: served by native libAppleDocsCore` (plus the fusion line) in the
search output. Edge healthz check from anywhere:
`curl -fsS https://<edge-host>/healthz`.

## Step 3 — Intel/WASM ≥5× measurement (ON mm18)

```bash
bash -lc '
cd ~/Developer/apple-docs
APPLE_DOCS_NATIVE_LIB=$PWD/dist/native/darwin-x64/libAppleDocsCore.dylib \
  bun test/benchmarks/embed-bench.js
'
```

On darwin-x64 the transformers leg automatically runs the WASM
onnxruntime fallback, so the printed `throughput ratio` IS the RFC 0002
§3 ≥5×-vs-WASM gate number. Paste the full bench output back into the
session — it gets recorded in RFC 0002 §3 + §6e.

## Rollback

`APPLE_DOCS_NATIVE=off` in ops/.env → `bun ops/cli.js render-all` →
`sudo bin/apple-docs-ops install` → restart services. Fusion/archive serve
identically from JS. Note (Stage C, 2026-06-11): the default embedding
model is native-only — with native off, semantic search degrades to
lexical-only rather than switching implementations.
