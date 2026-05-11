# S0.1 — SF-Pro.ttf presence spike

## Status
FOUND — `SF-Pro.ttf` is already extracted, retained, and shipped in the
snapshot tarball. No code change required for the planned cmap-based
symbol/codepoint work.

## Evidence

### Live install (mm18.local, `/Users/gc/.apple-docs`)
```
-rwxr-xr-x  25_872_268  resources/fonts/extracted/sf-pro/SF-Pro.ttf
-rwxr-xr-x  19_607_020  resources/fonts/extracted/sf-compact/SF-Compact.ttf
```
The `~25 MB` figure matches the question prompt almost exactly
(25.8 MB). Also surfaced alongside it:
`SF-Pro-Italic.ttf`, the seven other variable TTFs
(`SF-Arabic{,-Rounded}.ttf`, `SF-Armenian{,-Rounded}.ttf`,
`SF-Georgian{,-Rounded}.ttf`, `SF-Hebrew{,-Rounded}.ttf`,
`NewYork.ttf`, `NewYorkItalic.ttf`), and 47 static
`SF-Pro-{Display,Text}-…otf` files in `extracted/sf-pro/`.

`resources/fonts/original/` is empty — the install was bootstrapped from
a snapshot, not a fresh DMG sync (so no DMGs are retained locally; the
extracted payload is what crosses the wire).

### Sync code path
DMG URL list lives in `src/resources/apple-assets.js:46-55`:
```
{ id: 'sf-pro',     sourceUrl: '…/SF-Pro.dmg',     match: /^SF-Pro(?:-|\.|$)|^SFNS/i }
{ id: 'sf-compact', sourceUrl: '…/SF-Compact.dmg', match: /^SF-Compact(?:-|\.|$)|^SFCompact/i }
{ id: 'sf-mono',    sourceUrl: '…/SF-Mono.dmg',    match: /^SF-Mono(?:-|\.|$)|^SFNSMono/i }
{ id: 'new-york',   sourceUrl: '…/NY.dmg',         match: /^NewYork/i }
{ id: 'sf-arabic' / 'sf-armenian' / 'sf-georgian' / 'sf-hebrew' (… }
```

`syncAppleFonts` (`apple-assets.js:63-109`) loops the table, calls
`downloadFileIfNeeded` (`apple-fonts/sync.js:47`), then
`extractDmgFonts(dmgPath, familyDir, …)` (`apple-fonts/sync.js:72`).

The DMG walk in `extractDmgFonts`:
1. `hdiutil attach -readonly -nobrowse -mountpoint <tmp> <dmg>`
2. For every `.pkg` inside the mount, `pkgutil --expand-full <pkg> <tmp2>`
3. `discoverAppleFontFiles([mountDir, expandedDir])` walks both trees.

The filter that decides what lands in `resources/fonts/extracted/{id}/`
is the extension set on `apple-fonts/sync.js:16`:
```
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.dfont'])
```
`.ttf` is already in the set, so the variable TTFs are kept verbatim.
The walker also skips `__MACOSX` (`sync.js:39`) but has no other
allow/deny logic, so the variable font has never been "on the floor" —
it has always been retained alongside the static OTFs.

### Snapshot tarball
`src/commands/snapshot.js:135-138` packs the whole extracted tree:
```js
const fontsExtractedDir = join(dataDir, 'resources', 'fonts', 'extracted')
…
if (existsSync(fontsExtractedDir)) tarArgs.push('-C', dataDir, 'resources/fonts/extracted')
```
So `SF-Pro.ttf` (and the seven other variable TTFs) ride along inside
`apple-docs-<tier>-<tag>.tar.gz` with no per-file filter at the tar
boundary.

### DMG payload (Apple side)
`SF-Pro.dmg` from
`https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg`
contains a single `.pkg` (`San Francisco Pro.pkg`) whose payload
expands to a `Library/Fonts/` tree holding:
- `SF-Pro.ttf` (variable, ~25 MB) — the one we care about
- `SF-Pro-Italic.ttf` (variable italic axis)
- 47 static `SF-Pro-{Display,Text}-<Weight>{Italic}.otf`

`pkgutil --expand-full` is what surfaces the `Payload/Library/Fonts/…`
contents into `expandedDir`, which is the tree that `walkFiles` then
sweeps.

## Patch sketch
No patch needed — `SF-Pro.ttf` already extracts and ships. The cmap
work can rely on
`<dataDir>/resources/fonts/extracted/sf-pro/SF-Pro.ttf` being present
in any installation bootstrapped from a snapshot ≥ today, and in any
fresh `--download-fonts` sync.

If at some future point the team wants to *exclude* the static OTF
siblings to shrink the tarball but keep the variable TTF, the smallest
viable change would be at `src/resources/apple-fonts/sync.js:16`:
```diff
- const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.dfont'])
+ // Keep only the variable masters; the static OTFs are reproducible
+ // from the TTF via fontTools and we don't ship them as runtime assets.
+ const FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.dfont'])
```
…but that is an *optimisation*, not a fix, and it is out of scope for
S0.1. Filed here only so future readers know the right knob to turn.

## Companion files
- `SF-Pro.ttf`: PRESENT — `extracted/sf-pro/SF-Pro.ttf`, 25,872,268 bytes
- `SF-Pro-Italic.ttf`: PRESENT — same dir, variable italic
- `SF-Compact.ttf`: PRESENT — `extracted/sf-compact/SF-Compact.ttf`,
  19,607,020 bytes (variable)
- `SF-Compact-Italic.ttf`: PRESENT
- `SF-Mono.ttf`: **does not exist in Apple's DMG.** `SF-Mono.dmg` ships
  only 12 static OTFs (`SF-Mono-{Light,Regular,Medium,Semibold,Bold,
  Heavy}{,-Italic}.otf`). Apple has never released a variable master
  for SF Mono on the public design-resources channel. If the codepoint
  work needs a Mono cmap, any of the static OTFs will do — they share
  the same `cmap` coverage; or fall back to `SF-Pro.ttf`'s cmap, which
  is a strict superset.
- `NewYork.ttf` / `NewYorkItalic.ttf`: PRESENT (variable, for serif).
- Arabic/Armenian/Georgian/Hebrew variable TTFs: all PRESENT.

## Recommendation
Proceed with the cmap-based codepoint plan as designed — the file is
already there. The S0.1 acceptance criterion ("`SF-Pro.ttf` present in
snapshot") is satisfied by the current pipeline; no code change, no
backfill, no DMG re-extract. For SF Mono, plan around the fact that
only static OTFs exist upstream — either subset the cmap from one of
them or piggy-back on `SF-Pro.ttf`'s cmap (superset) for the
font-subset API's accept-set.
