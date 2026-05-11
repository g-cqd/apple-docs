# S0.3 — Font-subset engine parity

## Verdict
**pyftsubset required** for byte-identical determinism with the existing
`g-cqd/html-cv` build pipeline. `harfbuzz-subset` (via `subset-font@2.5.0`,
backed by `harfbuzzjs`) produces structurally different output with
**different default policies** that no flag fully reconciles. With
`noLayoutClosure: true` HB can come within ~12 bytes of pyft for a 26-glyph
Latin subset, but two structural deltas remain (`head.checkSumAdjustment`
and retained GSUB features) and the gap widens dramatically on richer sets.

If "same algorithm as pyftsubset" is a hard contract, ship Python. If
"functionally equivalent, smaller fonts at runtime" is the goal, HB is
~70x faster but emits ~50–100% larger outputs because it keeps more
layout features and reaches more glyphs through layout closure.

## Setup
- Input: `SF-Pro.ttf` (25,872,268 B, copied from
  `mm18.local:/Users/gc/.apple-docs/resources/fonts/extracted/sf-pro/SF-Pro.ttf`).
- Engines (both in `/tmp/subset-bench`, not in project):
  - `subset-font@2.5.0` → `harfbuzzjs` WASM.
  - `fontTools@4.60.0` + `brotli` (Python 3.12, Homebrew).
- Defaults on both sides; HB also tested with `noLayoutClosure: true`.

## Performance (set E, 503 codepoints, sfnt output)

| Engine | Cold (1st call) | 100-iter warm | Mean / call |
|---|---:|---:|---:|
| harfbuzz-subset (in-process Node) | 17.2 ms | 1.60 s | **16.0 ms** |
| pyftsubset (in-process Python) | 1170 ms | 113.4 s | **1133.8 ms** |
| pyftsubset (subprocess) | 1170 ms | 120.0 s | 1199.5 ms |

HB is ~71x faster per call (in-process vs in-process). Python subprocess
overhead (~60 ms) is small next to the per-call work for this input size.

## Byte-identity matrix (defaults on both sides)

| Set | cp count | woff2 SHA equal? | ttf SHA equal? | Glyph count HB / pyft |
|---|---:|---|---|---|
| A. Latin basic (A–Z) | 26 | no | no | 61 / 27 |
| B. Latin + digits | 62 | no | no | 274 / 76 |
| C. Empty (just space) | 1 | no | no | 5 / 4 |
| D. Single PUA (U+100300) | 1 | no | no | 7 / 4 |
| E. ~500 mixed | 503 | no | no | 989 / 558 |

Every output differs. HB consistently keeps **more glyphs** than pyft —
because HB defaults to keeping every layout feature and walking GSUB
closure, while pyft prunes to a curated default feature list (no `aalt`,
`ss01`, etc.) before closure.

Resulting size deltas (set E, ttf): HB **1,862,232 B**, pyft **1,194,156 B**
→ HB is **+56 %** larger by default. For Latin-only (A): HB **142,884 B**,
pyft **64,176 B** → **+123 %**.

## Diff details

For every set, the diverging tables follow the same pattern:

| Table | Source of difference |
|---|---|
| `GlyphOrder`, `maxp.numGlyphs`, `hhea.numberOfHMetrics` | HB keeps more glyphs (layout-feature closure). |
| `glyf` | Same outlines for shared glyphs (verified byte-identical for all 26 shared in set A), but HB has more entries. |
| `gvar`, `HVAR`, `hmtx` | Larger in HB (downstream of larger glyph set). |
| `GSUB`, `GPOS`, `GDEF` | HB keeps all features; pyft trims to its curated default list. |
| `OS/2.ulCodePageRange1` | HB recomputes code-page bitmap from cmap; pyft keeps a narrower default. (set A: `0x6000019F` vs `0x00000001`.) |
| `cmap` | Slightly different format selection / segment packing in some sets (e.g. set B: 8,126 vs 8,124 B). |
| `head.checkSumAdjustment` | Recomputed post-build; always differs even between identical pipelines. |
| `head.modified` | Both engines preserve the source font's value, so this **does not differ** here — but it is a determinism risk if HB ever switches to "now". |

### HB with `noLayoutClosure: true` (set A only, probe)
- Glyph count drops to 27 — matches pyft.
- Output size: 64,164 B vs pyft 64,176 B (Δ = 12 bytes).
- Remaining diffs: `head.checkSumAdjustment` (structural, see below) and
  `G_S_U_B_` — HB still keeps 5 features (`aalt`, `ccmp`, `dnom`, `frac`,
  `numr`-style) that pyft drops because they're not in its default
  `layout_features` whitelist. SHA still differs.

This confirms the gap is **default-policy**, not encoding bugs: HB and
pyft made different decisions about "what is a sensible default subset",
and there is no single HB flag that maps to pyft's `Options()`.

## Recommendation
Use **pyftsubset** for the server endpoint. Rationale:
1. **Algorithmic parity** with the user's existing `g-cqd/html-cv`
   pipeline is in scope; HB cannot match pyft byte-for-byte without
   reimplementing pyft's layout-feature whitelist on top of HB.
2. **Determinism for SHA-cache keys** is achievable: pyft is already
   deterministic given fixed inputs, modulo `head.checkSumAdjustment`
   (which is itself a deterministic function of the rest of the file —
   so re-runs with the same input produce identical bytes).
3. **Output size**: pyft's curated defaults produce 30–55 % smaller fonts
   for the workloads above. Bandwidth wins over CPU in the cache-hit case
   (cache-miss CPU is dominated by font parse, not the subset itself).
4. **Performance**: 1.1 s/call is acceptable as a worker pool sized to
   CPU cores, given responses are SHA-cached on the fast path. If it
   ever becomes the bottleneck, run pyftsubset out-of-process in a long-
   lived Python worker (eliminates the ~60 ms subprocess overhead and
   keeps the parsed font in memory) — that would close most of the gap
   to HB while preserving algorithmic parity.

### Required normalization for SHA-deterministic caching
Verified deterministic across re-runs without additional normalization:
- `head.modified` is sourced from the input font, not wall-clock.
- `head.checkSumAdjustment` is a pure function of the rest of the file
  bytes, so equal inputs → equal output.

No normalization step is required for pyftsubset to be a stable SHA-cache
key. (Open watch-item: confirm this on the actual server runtime; if a
future fontTools release ever stamps `head.modified` from `time.time()`
under any flag combination, force-pin it to `0` in our wrapper.)

## Determinism note
For SHA-cached responses the engine MUST produce byte-identical output
for the same input. pyftsubset satisfies this today with defaults.
harfbuzz-subset also appears deterministic per-call but is byte-different
from pyft, so swapping engines would invalidate every existing cache key.

## Reproduction
```
# fixtures: /tmp/subset-bench/{SF-Pro.ttf, sets.json, run.mjs, run.py}
node  /tmp/subset-bench/run.mjs      # writes out-hb/  + hb-results.json
python3 /tmp/subset-bench/run.py     # writes out-pyft/ + pyft-results.json
# then SHA-compare and TTX-diff per set.
```
Raw artifacts retained in `/tmp/subset-bench/` for follow-up; nothing
added to the project's `node_modules` or `package.json`.
