# mm18 — symbols and fonts cache rebuild

Operational runbook for the three deploy-side regressions surfaced in
`docs/research/fonts-symbols-ux.md` §2 (production findings #2, #3, #4).
None of these are source bugs — local renders are fine — so the fix is
ops-only and **must not** be applied from a developer machine.

| Source | Issue | Severity |
|---|---|---|
| §2 #2 | `document.fonts.ready` never resolves on prod `/fonts`; ≥1 `@font-face` URL stays in `loading` indefinitely | P1 |
| §2 #3 | Prod symbol DB ~9% behind local (8 954 vs 9 872 symbols) | P1 |
| §2 #4 | Prod renderer cache emits half-scale viewBoxes (e.g. pencil `0 0 226.1 224.85` vs local `0 0 452.2 449.7`) | P1 |

The runbook is intentionally idempotent. Each step ends with a verify
command. If a verify fails, stop, capture the failure, and escalate
before retrying.

---

## Pre-flight

- SSH into mm18 and `cd /opt/apple-docs` (or wherever the deploy
  checkout lives).
- Confirm the deploy is healthy *before* you start so you know the
  baseline:
  ```sh
  curl -sf https://apple-docs.everest.mt/healthz
  ```
- Snapshot the database before destructive steps (the cache resets
  delete render rows but never user data; still cheap insurance):
  ```sh
  cp data/db.sqlite data/db.sqlite.bak.$(date +%Y%m%d-%H%M%S)
  ```
- Note current counts so you can diff them after:
  ```sh
  curl -sf https://apple-docs.everest.mt/symbols | grep -oE 'symbols indexed' \
    && curl -sf https://apple-docs.everest.mt/api/symbols/index.json | jq .count
  ```
  Expected after the rebuild: `count` matches the local value
  (~9 872 at the time of the synthesis; it will drift forward as Apple
  ships new symbols).

---

## 1. Re-ingest SF Symbols (fixes §2 #3)

`apple-docs symbols ingest` walks the bundled CoreGlyphs catalog and
upserts every symbol into the `sf_symbols` table. The 9% gap on prod is
a stale-DB issue — the rebuild is a no-op for symbols already present.

```sh
apple-docs symbols ingest
```

Verify:

```sh
sqlite3 data/db.sqlite 'SELECT scope, COUNT(*) FROM sf_symbols GROUP BY scope'
# expect counts that sum to the local total (re-check the synthesis if unsure)
```

If the count is still short, the catalog files on the deploy host are
stale. Re-sync `src/resources/glyphs/` from the repo and re-run.

---

## 2. Reset and re-render the symbol cache (fixes §2 #4)

The half-scale viewBox is a stale prerender — the renderer changed
upstream but the on-disk PNG/SVG cache was never invalidated. We use
the explicit reset flag rather than touching the cache directory by
hand so the index stays consistent.

```sh
apple-docs symbols render --reset-cache
```

This walks every symbol, regenerates the canonical theme-neutral SVG
on disk, and bumps the cache key. Expect the run to take a few minutes
on mm18 — the renderer is single-threaded by design.

Verify:

```sh
curl -sf 'https://apple-docs.everest.mt/api/symbols/public/pencil.svg' \
  | grep -oE 'viewBox="[^"]+"'
# expect: viewBox="0 0 452.2 449.7"  (NOT 226.1 224.85)
```

Cross-check with `heart.fill`, `gear`, `trash`, `plus`, `arrow.right` —
all five share the same 2× ratio in the original probe.

---

## 3. Audit `dist/web/assets/fonts/*` (fixes §2 #2)

`document.fonts.ready` hangs because at least one URL in the 171
`@font-face` rules emits a `loading` promise that never resolves. The
likely culprit is a missing or zero-byte file under
`dist/web/assets/fonts/` whose URL is still referenced from the build.

Inventory first:

```sh
find dist/web/assets/fonts -type f -size 0c
find dist/web/assets/fonts -type f -name '*.ttf' -o -name '*.otf' -o -name '*.ttc' \
  | xargs -I{} sh -c 'test -s {} || echo "EMPTY: {}"'
```

Cross-reference with the in-flight font URLs the live site emits:

```sh
curl -sf https://apple-docs.everest.mt/api/fonts | jq '.families[].files[].id' \
  | head -20
```

For every font ID returned by `/api/fonts`, hit
`/api/fonts/file/<id>` and confirm a non-zero `Content-Length`:

```sh
curl -sIf 'https://apple-docs.everest.mt/api/fonts/file/<id>' | grep -i content-length
```

If a font is missing on disk, re-run the asset extraction step that
populates `dist/web/assets/fonts/`. Typically:

```sh
apple-docs setup --fonts-only --reextract
```

Then `apple-docs web build` to regenerate `index.html` etc. (or rely on
the dev-served `/fonts` route, which uses the live DB and doesn't read
from `dist/web/assets/fonts/` at all — handy for triage).

Verify:

```sh
# All 171 fonts respond 200 with nonzero Content-Length
curl -sf https://apple-docs.everest.mt/api/fonts \
  | jq -r '.families[].files[].id' \
  | xargs -I{} curl -sIo /dev/null -w '%{http_code} %{size_download} {}\n' \
      "https://apple-docs.everest.mt/api/fonts/file/{}" \
  | awk '$1 != 200 || $2 == 0 { print "BAD:", $0 }'
```

The probe script should print nothing if the font set is healthy.

Browser check (DevTools console on prod `/fonts`):

```js
document.fonts.ready.then(() => console.log('OK')).catch(e => console.error(e))
```

`OK` should print within a couple of seconds. If it still hangs, narrow
to the offending family by binary-searching the `@font-face` injection
order in `src/web/assets/fonts-page.js` and removing batches until
ready resolves — the file with no resolution is the broken one.

---

## 4. Republish

Once §1–§3 verify clean:

```sh
apple-docs web build
# then deploy via the standard pipeline (Caddy reload picks up the new dist)
```

Final verify — re-run the production probe from the synthesis:

```sh
# Symbol count parity
curl -sf https://apple-docs.everest.mt/api/symbols/index.json | jq .count
# /fonts FontFaceSet ready (browser-side)
# Same 5 symbols probed in §2 #4 should now have full-scale viewBoxes
for n in pencil heart.fill gear trash plus arrow.right; do
  curl -sf "https://apple-docs.everest.mt/api/symbols/public/$n.svg" \
    | grep -oE 'viewBox="[^"]+"'
done
```

---

## Notes

- These three fixes are *deploy-side only*. Re-running them on a dev
  machine does nothing — local was already correct. The runbook
  exists so the next P0 incident with the same shape can be cleared
  in one pass instead of three.
- If the symbol render reset is interrupted (SIGINT, OOM), it is safe
  to re-run — the renderer skips already-current rows.
- The asset version (`?v=…`) bumps on every server restart, so once
  step 4 lands, browsers fetch the regenerated bundles immediately.
- See `docs/research/fonts-symbols-ux.md` §10 for the file-touch
  ledger that called this runbook out as an ops task rather than a
  P7 source change.
