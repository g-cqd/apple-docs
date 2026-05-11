# Spike: SF Symbol → Unicode codepoint mapping

**Status:** BLOCKED. Stopping per task instructions and writing up the finding before wiring anything into sync / migrations / the route layer.

**Date:** 2026-05-11
**Font under test:** `/Users/gc/.apple-docs/resources/fonts/extracted/sf-pro/SF-Pro.ttf` (25,872,268 bytes)
**Parser:** `src/resources/apple-symbols/codepoint-from-font.js` (hand-rolled `cmap` formats 4 + 12 and `post` format 2)
**Probe script:** `scripts/spike-sf-pro-cmap.js`
**Cross-check tool:** Python `fontTools` 4.60.0 (system install)

## TL;DR

The premise the task is built on — that SF-Pro.ttf's `post` table holds
glyph names matching the SF Symbol catalog names (`house.fill`,
`person.crop.circle`, …) and that joining the `post` and `cmap` tables
yields `catalogName → codepoint` — **does not hold for SF-Pro.ttf as
shipped on macOS 26.4**. There is no JS-only path from the font alone
to the catalog-name codepoint.

The parser itself works: cmap, post, the PUA filter, and the
glyph-name extraction all return what the OpenType spec says they
should. fontTools agrees with our parser on every probe. What's
missing is the catalog-name layer, which lives outside the font.

I'm stopping at the parser + spike. The migration, sync stamp, route
serializer, detail-panel row, and tests are **not** yet written — they
all depend on a working name resolution and would otherwise stamp
`NULL` on every public symbol.

## What the parser sees

```
Reading: /Users/gc/.apple-docs/resources/fonts/extracted/sf-pro/SF-Pro.ttf
Parsed 8314 (glyphName → PUA codepoint) entries in 32.1 ms

First 20 entries by codepoint:
  U+F6D5      uni100136.small
  U+F6D6      uni100137.small
  …
  U+100000    uni100000.medium
  U+100001    uni100001.medium
  …

Probes:
  house                        MISSING
  house.fill                   MISSING
  globe                        MISSING
  star                         MISSING
  star.fill                    MISSING
  person.crop.circle           MISSING
  pencil.and.sparkles          MISSING
```

8,314 PUA glyphs are reachable via cmap. Every name has the form
`uniXXXXXX[.size]` — i.e. the post table tells us "the glyph at
codepoint U+XXXXXX is named `uniXXXXXX`", which is tautological. The
SF Symbol catalog name layer is not present at this seam.

## Why the mapping is missing

SF-Pro.ttf has **35,026 total glyphs** but only 8,314 PUA-mapped
codepoints. The other 26,712 glyphs are not directly addressable via
`cmap`; they are reached through OpenType GSUB substitutions (the
`ssNN` stylistic sets, plus contextual rules) that the SF Symbols
runtime triggers when an app asks for `house.fill` at a given
weight/scale.

The `post` table **does** carry the catalog-shaped names — e.g.
`house.color`, `house.fill.color`, `pencil.tag.color.medium`,
`globe.fill.crop.color`. But:

1. None of those glyphs has a `cmap` entry, so they don't have a
   "their own" codepoint.
2. The base catalog names (`house`, `globe`, `pencil`) are not in the
   `post` table at all — verified against the full 35,026-element
   glyph order via fontTools.

The `Assets.car` CoreGlyphs catalog (dumped via `assetutil`) has
8,303 entries with `Name` + `NameIdentifier` fields. The
`NameIdentifier` values (e.g. `house.fill` → 22827) are **not**
codepoints; they're string-pool indices.

`/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/metadata/metadata.store`
is the most likely location of the runtime name→codepoint table, but
it's a 588 KB undocumented binary format flagged as compressed in
`index.plist` (`isCompressed = true`, no documented schema).

## Options for an actual fix

Listed in order of cost / risk:

1. **Bake the mapping at snapshot build time using a Swift helper**
   that asks CoreText for `CTFontCopyCharacterIdentifiersForGlyphs`
   or queries the SF Symbols framework directly. Ship the resulting
   `(name, codepoint)` pairs as a JSON sidecar in the snapshot — we
   already have a Swift worker (`SYMBOL_WORKER_SCRIPT`) for the
   prerender, so adding a one-shot dump step is cheap. Pure
   JS/parse-side stays read-only.

2. **Resolve GSUB substitutions in JS** starting from the
   `uniXXXXXX.medium` cmap entries and walking the substitution
   chain to the named target glyphs. The GSUB table in SF-Pro.ttf is
   complex (multiple lookup types, contextual rules); ~600 lines of
   new parser code, and we'd still need to know which substitution
   chain corresponds to which catalog suffix (`.fill`, `.circle`).

3. **Reverse-engineer `metadata.store`**. High risk: undocumented,
   may change format between macOS releases, and the existing
   apple-docs pipeline pinned to a specific SFSymbols version would
   need a parser update on each snapshot rebuild.

4. **Shell out to Python `fontTools` plus a community-maintained
   `sf-symbols-extractor`** at sync time. Violates the "no new deps,
   no project-level pip" constraint and adds a runtime dependency on
   third-party code that tracks SF Symbols releases.

My recommendation is **Option 1** (Swift helper at snapshot time).
It matches the existing prerender pipeline architecture — we already
shell out to Swift for symbol PDF rendering, so a sibling "name dump"
worker fits naturally. The DB column + route serializer + detail-panel
row from this task all still apply, but the source of truth for the
mapping changes from SF-Pro.ttf to the Swift helper's JSON output.

## What ships from this spike

| Path | Status | Note |
| --- | --- | --- |
| `src/resources/apple-symbols/codepoint-from-font.js` | written, correct, currently unused | exposes `buildNameToCodepointMap`, `isPrivateUseCodepoint`, `formatCodepoint`. Reusable when a future GSUB-walking layer needs the cmap join. |
| `scripts/spike-sf-pro-cmap.js` | written | runnable verification; produces the output above. |
| `docs/spikes/sf-symbol-codepoints.md` | this file | the writeup. |

The DB migration, `db.updateSfSymbolCodepoint`, the
`symbolMetadataHandler` serializer, the detail-panel row, and the
tests called for in the task are **not** in this commit. They would
all hang off an `(name → codepoint)` source that, per the evidence
above, has to come from outside SF-Pro.ttf.

Awaiting direction on which of the four options above to pursue.
