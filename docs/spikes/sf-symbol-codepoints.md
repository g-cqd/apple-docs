# Spike: SF Symbol → Unicode codepoint mapping

**Status:** BLOCKED. Stopping at the stop condition defined by the task — all
three sub-paths (C.1 public API, C.2 dlopen + Swift, C.3 metadata.store
binary walk) are intractable within the 2-hour budget. Best achievable
coverage from a hybrid is ~45%, well below the 90% acceptance threshold.

**Date:** 2026-05-11
**macOS under test:** 26.4 (snapshot of system frameworks + SF Symbols.app 7.x)
**Probe artefacts:** `/tmp/probe-*.swift`, `/tmp/coverage-test.swift`
**Existing artefacts kept on disk:** the unstaged P1.4 scaffolding (DB
migration v19, `db.updateSfSymbolCodepoint`, `dumpSymbolCodepoints` JS
orchestrator, route + UI wiring, tests). The Swift worker still uses the
unsuccessful `CTFontGetGlyphWithName` strategy; it is intentionally left
as-is because no replacement reaches the acceptance bar.

## TL;DR

The premise that catalog names like `house.fill` can be resolved to PUA
codepoints by walking the SF Pro / SF Symbols font tables holds for
roughly half the catalog. The other half lives behind an encrypted /
private surface that we cannot reproduce without either:

1. shipping a custom hardcoded mapping (forbidden by task constraints), or
2. depending on the Swift `SFSymbolsShared.framework` private API which
   requires a `.swiftmodule` that Apple does not distribute.

I am stopping per the task's stop condition.

## Path-by-path findings

### C.1 — Public Apple Symbol APIs

Dead.

- `Symbols.framework` (public, has `.swiftinterface` in the SDK): only
  exposes symbol-effect types (Pulse, Bounce, VariableColor, …). No
  catalog query, no `unicodeScalar`, no `glyphID` accessor on any of the
  638 lines of interface surface.
- `NSImage(systemSymbolName:)` + `withSymbolConfiguration(_:)` produce a
  `NSSymbolImageRep` backed by a `CUINamedVectorGlyph`. The vector glyph
  exposes `name` (the catalog name itself), `pointSize`, `scale`,
  `baselineOffset` — no scalar or codepoint accessor on any superclass.
- Method-list and ivar-list probes against `NSImage`, `NSImageRep`,
  `NSSymbolImageRep`, `CUINamedVectorGlyph`, `CUINamedLookup` find no
  public, private, or `_underscore`-prefixed accessor that yields a
  codepoint. Closest is `_symbolName` on `NSImage`, which returns the
  catalog name we passed in.

### C.2 — dlopen + Swift symbol resolution against CoreGlyphsLib / SFSymbolsShared

Partial; not sufficient.

- `SymbolStore.init(fontGroup: FontGroup)` is the catalog entry point in
  `CoreGlyphsLib.framework`. `SymbolStore.getSymbol(_:String)` returns a
  `Symbol`. Neither type exposes the codepoint directly — `Symbol`'s
  `init(_:String, from: FontGroup, nameMap: [String:String], glyphName: String, ...)`
  shows the layer where the catalog→font-glyph mapping happens, but the
  `nameMap` and `glyphName` arguments are supplied by a higher layer.
- That higher layer is `SFSymbolsShared.framework`. Demangling its 4,692
  exported symbols turned up the real catalog:
  - `SymbolMetadataStore.symbolMetadata(forSystemName: String) -> SymbolMetadata?`
  - `SymbolMetadata.privateScalar: Unicode.Scalar?`
  - `SymbolMetadata.publicScalars: [Unicode.Scalar]`
  - `SymbolFontReader.init(symbolFontProvider:, metadataReadingOptions:)`
  - `MetadataReadingOptions(metadataDirectory: URL)` accepting the
    `/System/Library/PrivateFrameworks/SFSymbols.framework/.../metadata` path
- **Blocker:** `SFSymbolsShared.framework` ships **without** a
  `.swiftmodule` or `.swiftinterface`, so we cannot `import SFSymbolsShared`
  from a Swift source file. The framework binary is loadable via
  `dlopen`, but its public surface is pure Swift (structs, generic
  initializers with protocol constraints, throwing initializers) that
  cannot be called via the Objective-C runtime. Calling it via raw
  `dlsym` + manually fabricated mangled-name lookups is technically
  possible but requires reconstructing Swift's metadata layout
  (`SymbolFontReader` ivar offsets, witness tables for
  `SymbolFontProvider`, `MetadataReadingOptions`'s padding, etc.) — that
  is a multi-day project, far outside the 2 h budget, and the result
  would break on any Swift compiler bump or framework rebuild.
- One @objc-exposed hook does exist on `CUICatalog`:
  `_baseVectorGlyphForName:` returns a `CUIRenditionKey` whose
  `themeIdentifier` is a 16-bit NameIdentifier per catalog name. This
  works for all 8,303 public symbols.

### C.3 — Walk the metadata.store binary format

Dead.

- File header is `1f e5 2b ff`, not any of the documented Apple
  compression magic numbers (`zlib`, `LZ4`, `LZMA`, `LZFSE`,
  `Brotli`, `LZBITMAP`).
- Apple's `compression_decode_buffer(COMPRESSION_ZLIB)` from offset 4
  decodes the first 65,536 bytes of source into 48,003 bytes of output —
  but the output has 7.95 bits/byte entropy and no plist / JSON / utf-8
  prefix. The data is **encrypted**, not just compressed.
- That matches what we found in `SFSymbolFontReader.MetadataReadingOptions`:
  it carries an explicit `fontTableDecryptor: ((CTFontRef, UInt32) -> Data?)?`
  callback. The system framework decrypts metadata at runtime using a
  key bound to the CT font object. Without invoking the framework's
  decryptor, the bytes are useless.

## What the hybrid prototype achieves

Best in-budget Swift prototype combining C.2's `_baseVectorGlyphForName:`
hook with a font-side lookup against `SFSymbolsFallback.otf` (the 94 MB
font bundled with `SF Symbols.app` that contains the catalog rendering):

1. For each of the 8,303 public catalog names, call
   `CUICatalog._baseVectorGlyphForName:` to get a `themeIdentifier`
   NameIdentifier (16-bit).
2. If `NameIdentifier < CTFontGetGlyphCount(SFSymbolsFallback.otf)` (i.e.
   below 40,852) AND `CTFontCopyNameForGlyph` returns a name matching
   `uniXXXXXX[.size]`, the hex digits after `uni` are the codepoint.
3. Otherwise, no codepoint available from this surface — emit `null`.

Measured outcome:

```
total catalog names: 8303
resolved: 3770 (45.4%)
unresolved: 4533 (54.6%)
```

Sample unresolved cases:

```
ellipsis.viewfinder           NID 54414 (> font glyph count 40852)
rectangle.arrowtriangle.2.outward  NID 51482
figure.strengthtraining.traditional  NID 47753
phone.down.waves.left.and.right  NID 9005, name=rectangle.3grid.bubble.color
28.square.hi                  NID 60203
app.dashed                    NID 60019
forward.circle                NID 43508
chart.xyaxis.line             NID 48200
pencil.and.list.clipboard     NID 51504
inset.filled.bottomthird.square  NID 1944, name=Ibreve.1.sc
```

Two unresolved patterns:

- **NID > 40852:** NameIdentifier is a catalog asset ID, not a glyph
  index. The mapping from NameIdentifier to font glyph for these symbols
  lives in `SFSymbolsShared`'s encrypted font tables (`syls` and `symp`
  in `SFSymbolsFallback.otf`).
- **NID < 40852 but the font glyph is not a `uniXXXX*` name** — these
  are symbols where the canonical font glyph is a multicolor/variant
  representation (e.g. `Ibreve.1.sc`, `rectangle.3grid.bubble.color`),
  and the base codepoint lives at a different glyph that we cannot
  identify from this surface.

45% coverage is materially below the 90% acceptance bar, so this
prototype is not wired in.

## Options for a real fix (no change since the previous spike)

1. **Bake the mapping at SF Symbols release time using Apple's `SFSymbols`
   command-line export.** The SF Symbols.app `Export…` menu writes a
   `.symbolset` directory plus a `metadata.json` containing
   `unicodePoint` per symbol. This would be a manual or CI-time export,
   not a runtime extraction.
2. **Vendor a `(name, codepoint)` JSON for the supported macOS major
   version.** Forbidden by the task constraint "Don't introduce ANY
   hardcoded codepoint mapping". (The constraint conflicts with the
   acceptance bar; this is the conflict that produced the stop condition.)
3. **Write a custom Swift framework that links against
   `SFSymbolsShared.framework` via Xcode's private-framework search
   path, ship the resulting `(name, codepoint)` dump as a snapshot
   sidecar.** This requires the SF Symbols.app to be installed at sync
   time and pinned to a known version. Heavy, but it's the only path
   that reaches >99% coverage.

My recommendation is **Option 3**, executed off-line and the output
shipped as a snapshot artefact, not via runtime extraction. Until that
work happens, the `sf_symbols.codepoint` column will stay NULL.

## What ships from this spike

| Path | Status |
| --- | --- |
| `src/resources/apple-symbols/codepoint-from-font.js` | unchanged, still correct for the 8,314 cmap-addressable entries; not connected |
| `src/resources/apple-symbols/codepoint-dump.js` | scaffolded by the previous P1.4 agent, unchanged, currently writes `NULL` for every symbol because the Swift worker can't resolve catalog names |
| `src/resources/swift/symbol-codepoint-worker.js` | unchanged, still using `CTFontGetGlyphWithName` which returns 0 for all catalog names |
| `src/storage/migrations/v19-sf-symbols-codepoint.js` | unchanged, valid schema |
| `src/storage/repos/assets-symbols.js` (`updateSfSymbolCodepoint`) | unchanged |
| `src/web/routes/symbols.route.js` (codepoint serialization) | unchanged |
| `src/web/assets/symbols-page/detail-panel.js` | unchanged |
| `test/unit/symbol-codepoints.test.js` | unchanged |

The schema migration, repo method, route, and detail-panel row are all
correct and safely emit nothing when `codepoint IS NULL`. They will
start producing data the moment a future fix populates the column.

## Verdict

**Definitively unreachable from the public/semi-public surface within
the 2-hour budget.** The complete catalog name→codepoint mapping is
gated behind Swift-only private APIs (`SFSymbolsShared.SymbolMetadataStore`)
that have no Objective-C shim and no published Swift module.
Reaching ≥90% coverage requires shipping the data out-of-band — either
as a build-time export from SF Symbols.app's own export feature, or via
a custom Swift binary linked against the private framework with a
matching pinned macOS SDK.
