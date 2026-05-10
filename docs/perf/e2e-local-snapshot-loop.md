# End-to-end local snapshot loop

Validated 2026-05-10 against the live Apple corpus on macOS 14.x.
Erase → sync → snapshot build → erase → setup from the local archive →
verify. Use this when you need to confirm the operator loop closes on a
clean machine without going through a GitHub release.

## Commands

```bash
# 1. Erase the local data directory.
rm -rf ~/.apple-docs

# 2. Full sync against the live Apple API. Default concurrency (100 req/s).
#    APPLE_DOCS_DOWNLOAD_FONTS=1 so the snapshot ships the Apple typography
#    DMGs (font index points at extracted files inside the snapshot).
APPLE_DOCS_DOWNLOAD_FONTS=1 apple-docs sync --verbose 2>&1 | tee /tmp/sync.log

# 3. Build the snapshot. --allow-incomplete-symbols covers the ~50
#    catalog-noise names (`symbols`, `year_to_release`) that don't have
#    a renderable vector form; see "Known noise" below.
TAG="e2e-$(date -u +%Y%m%dT%H%M%SZ)"
apple-docs snapshot build --tag "$TAG" --allow-incomplete-symbols 2>&1 | tee /tmp/snapshot.log

# 4. Wipe again to simulate a fresh install host.
rm -rf ~/.apple-docs

# 5. Install from the local tarball. --archive lives under $HOME or cwd;
#    a sibling .sha256 / .manifest.json are picked up by name convention.
apple-docs setup --archive "dist/apple-docs-full-${TAG}.tar.gz" 2>&1 | tee /tmp/setup.log

# 6. Verify.
apple-docs status --json | jq '{docs: .pages.active, capabilities, tier, failed: .crawlProgress.failed}'
apple-docs search 'NavigationStack' --limit 3
apple-docs read swiftui/view --max-chars 200
```

## Observed timings (M1/M2-class Mac, this corpus)

| Phase | Wall-clock |
|---|---|
| Sync — 8 phases (update → discover → crawl → download → convert → body-index → resources → consolidate) | ~17 min |
|   • crawl + body-index (apple-docc 329k docs) | ~14 min |
|   • Apple fonts DMG download + extract | ~2 min |
|   • SF Symbols catalog sync + 225,720 variant pre-render | ~4 min |
|   • consolidate (minify + checkpoint) | ~1 min |
| Snapshot build (VACUUM INTO + tar of 942k entries) | ~8 min |
| Setup from local archive (verify + tar extract + symbol re-index) | ~2 min |
| **Total wall-clock** | **~27 min** |

The bulk of the sync time is the per-page HEAD check during the `update`
phase and the apple-docc framework crawl. Symbol pre-render is now
~4 min for the full 225k-variant matrix thanks to the long-lived Swift
worker.

## Known noise

### Catalog meta-names (4 entries)

`public/symbols`, `public/year_to_release`, `private/symbols`,
`private/year_to_release` appear in the CoreGlyphs `symbol_search.plist`
catalog but don't have a renderable vector form. Each fails the prerender
with "worker exited" — the Swift NSImage handle accepts the name but
crashes during `-vectorGlyph drawInContext:`. Total: 56 missing variants
(2 names × ~14 weight/scale combinations × 2 scopes).

Currently surfaced via `--allow-incomplete-symbols` on snapshot build. A
follow-up should filter these meta-names at catalog ingest time
(`src/resources/apple-symbols/sync.js::syncSfSymbols`) so they never
reach the prerender loop.

### Apple API 403/404s during crawl

Apple's tutorials/data CDN returns 403 (gated) or 404 (truly missing)
for ~15 documented paths in a typical full crawl — `.composer` accessors
on a handful of foundation types, deeply-nested `links` shapes under
`enterpriseprogramapi`, certain `webkit/wkwebview` overloads. These show
up in the log at `debug` level (`Failed: <path>`) and the `crawl_state`
table records them with `status='failed'`. The next sync run retries
them; if Apple still 403/404s, the page never persists. Normal.

## Failure modes hit during validation

### Swift worker tab-character bug (fixed pre-validation)

The first sync attempt crashed every symbol prerender at the Swift
compile step: `let parts = line.split(separator: "\t", ...)` rendered to
disk with a literal TAB byte rather than the escape sequence, which the
current Swift compiler rejects with "unprintable ASCII character found
in source file". Fix was to double-escape in the JS template so the
written Swift file contains `\t` (2 chars). Verified by running the
extracted worker script through `swift` directly.

If a future Bun / Swift upgrade reintroduces a similar parse error,
extract the worker source with:

```js
import { SYMBOL_WORKER_SCRIPT } from './src/resources/swift-templates.js'
process.stdout.write(SYMBOL_WORKER_SCRIPT)
```

and pipe through `swift -typecheck` (or `swiftc -parse`) to bisect.

### Sync interruption recovery

If the sync dies mid-way (network blip, OOM, user Ctrl-C), the next
`apple-docs sync` invocation resumes:

- `crawl_state.status='failed'` rows retry automatically.
- `sync_checkpoint` row `body-index:incremental` records the last
  processed document id; the body index resumes from there.
- Already-rendered SF Symbol SVGs are detected on disk (`existsSync` +
  `size > 0`) and skipped.
- The pre-rendered SVG meta.json is rewritten if the renderer version
  changed since the last pass.

Validated by killing the first sync mid-prerender and re-running. The
second invocation took ~5 min total (HEAD checks + 4 min prerender) vs
the cold-start 17 min.

## Verify checklist

| Check | Pass criterion | Observed (2026-05-10) |
|---|---|---|
| `apple-docs status --json .capabilities` | all four `true` | search, searchTrigram, searchBody, readContent — all `true` |
| `apple-docs status --json .pages.active` | within 5% of baseline | baseline 346,379 → snapshot 329,168 (drift between crawl runs, not a setup bug) |
| `apple-docs search 'NavigationStack' --limit 3` | SwiftUI symbol in top 3 | `swiftui/navigationstack` ranked #1 |
| `apple-docs read swiftui/view` | returns abstract + platforms list | `title: View / framework: SwiftUI / role: symbol / role_heading: Protocol` |
| `apple-docs status --json .crawlProgress.failed` | 0 after a clean install | 0 |
| `du -sh ~/.apple-docs` | matches manifest doc size | 12 GB (matches `dbSize 3.4 GB + raw-json + markdown + resources`) |

## Snapshot artifact layout

`apple-docs snapshot build --tag <tag>` writes to `dist/`:

```
dist/
├── apple-docs-full-<tag>.tar.gz         # corpus (~1.5 GB compressed)
├── apple-docs-full-<tag>.sha256         # checksum of the tarball
└── apple-docs-full-<tag>.manifest.json  # metadata: schema, doc count, checksum
```

Manifest:

```json
{
  "version": "<tag>",
  "schemaVersion": 18,
  "tier": "full",
  "createdAt": "2026-05-10T21:28:28.876Z",
  "documentCount": 329168,
  "dbChecksum": "19eb517b…",
  "dbSize": 3427708928,
  "archiveSize": 1585186704,
  "archiveChecksum": "68deca1d…"
}
```

`setup --archive <path>` discovers the sidecars by name convention:
`stripTarGz(path) + '.sha256'` and `stripTarGz(path) + '.manifest.json'`.
Missing sidecars produce a `warn` log and proceed (the local-archive
path treats checksums as an operator policy, not a correctness gate —
the operator built the archive themselves).
