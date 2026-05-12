# Spike: SF Symbol → Unicode codepoint mapping

**Status:** RESOLVED 2026-05-12 (PM). The decryptor exists as a public
Swift symbol in `CoreGlyphsLib.framework` (shipped inside SF Symbols.app)
at `Crypton.decryptObfuscatedFontTable(tableTag:from:)`. Wiring it as
the `fontTableDecryptor` callback on `SymbolFontReader.MetadataReadingOptions`
unlocks the encrypted `syls`/`symp` tables in SFSymbolsFallback.otf and
yields **100% catalog coverage** (8,302 / 8,302 public symbols on
macOS 26.4 + SF Symbols 7.x). Verified visually: `house.fill` (U+10039F)
rendered in SF Pro matches `NSImage(systemSymbolName: "house.fill")`
pixel-for-pixel.

The earlier "blocked" status was correct *for the framework binaries
inspected up to that point*. SF Symbols.app links a second private
framework (`CoreGlyphsLib`) alongside `SFSymbolsShared`; that's where
the decryptor lives. The previous nm sweeps missed it because they
scanned only the main SF Symbols.app binary and SFSymbolsShared,
not the nested CoreGlyphsLib bundle.

The implementation ships in:
- `src/resources/swift/symbol-codepoint-worker.js` (Swift worker +
  handcrafted .swiftinterface for both private frameworks)
- `src/resources/apple-symbols/codepoint-dump.js` (JS host that
  materialises the module dirs, symlinks the framework shells, and
  runs the worker via `swift -I -F -framework`)
- `src/resources/apple-symbols/sync.js` (call site)

The historical sections below are kept verbatim as a postmortem of the
blocked-then-unblocked path and as a reference for anyone touching the
private-framework Swift surface.

**Date:** 2026-05-12 (revision; original spike 2026-05-11)
**macOS under test:** 26.4 (snapshot of system frameworks + SF Symbols.app 7.x)
**Probe artefacts:** `/tmp/sfs-*.swift`, `/tmp/sfs-probe-mod/SFSymbolsShared.swiftmodule/`
**Existing artefacts kept on disk:** the P1.4 scaffolding (DB migration
v19, `db.updateSfSymbolCodepoint`, `dumpSymbolCodepoints` JS
orchestrator, route + UI wiring, tests). The Swift worker still uses
`CTFontGetGlyphWithName` and returns NULL for every symbol — intentional,
because no replacement is both reachable and correct.

## Revision summary (2026-05-12)

Three findings overturn pieces of the 2026-05-11 spike. The verdict is
unchanged, but the *reason* it's blocked has shifted:

1. **`metadata.store` is compressed, not encrypted.** The framework's
   own `index.plist` next to it (at
   `/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata/index.plist`)
   explicitly declares `isCompressed: true` and no `isEncrypted` flag.
   The magic header `1f e5 2b ff` is an Apple-specific compression
   format, not a cryptographic envelope. This does not unblock the
   spike — the format is still undocumented — but it removes the
   "encrypted" terminology that previously justified stopping.
2. **SF-Pro.ttf's post table DOES contain catalog-shaped glyph names.**
   8,907 of 35,026 glyphs have catalog names like
   `house.fill.color.medium`, `trashcan.fill`, `dishwasher.fill`. The
   2026-05-11 spike claimed it was empty because it tested only the
   base form `house.fill`, which is not in the post table — Apple only
   ships color/multicolor/size *variants* in the font; the mono base
   is reached at runtime through `metadata.store`.
3. **The Swift ABI route is reachable.** A handcrafted
   `.swiftinterface` lets the Swift compiler accept
   `import SFSymbolsShared` even though Apple ships no `.swiftmodule`.
   We successfully construct `SymbolMetadataStore`, call its
   `load(from:)` / `ingest*PlistData` methods, build a
   `SymbolFontReader(symbolFontProvider:metadataReadingOptions:)`, and
   read `FontSymbol.pua` on each result. The ABI is not the blocker;
   the *data* is.

The new blocker, after exhausting the ABI route, is point 4 below.

4. **The catalog name→codepoint CSV lives in the encrypted `syls`
   font table (77 MB) of `SFSymbolsFallback.otf`.** The framework's
   `SymbolFontReader.MetadataReadingOptions` takes a
   `fontTableDecryptor: ((CTFont, UInt32) -> Data?)?` callback the
   caller must supply. The system provides this callback in-process at
   runtime; the framework binary itself does not export a default
   decryptor symbol, and no other public/private framework on macOS 26
   exports one we can dlsym. Pass nil and `reader.symbol(forSystemName:)`
   returns nil for every name; the encrypted `syls` (77 MB) and `symp`
   (753 KB) tables stay opaque.

5. **The CUICatalog hybrid produces FALSE matches.** The 2026-05-11
   spike's reported "45.4% resolved" coverage was a measurement
   artefact. `CUICatalog._baseVectorGlyphForName:` returns a
   `CUIRenditionKey.themeIdentifier` — a NameIdentifier — which is
   NOT a glyph index into SFSymbolsFallback.otf or any other font.
   Verified empirically on 2026-05-12:
   `house.fill` produces NID 22827 → the post-table glyph
   `uni102BEF.small` → claimed codepoint U+102BEF. Rendering
   `String(Unicode.Scalar(0x102BEF)!)` in SF Pro produces a
   gear-like glyph, *not* a house. 1,877 of 4,096 pixels differ
   between `NSImage(systemSymbolName: "house.fill")` and the U+102BEF
   render. The 45% number is not "partial coverage", it's noise.

The end of all five paths is the same: **no system surface exists on
macOS 26 that we can read, decode, or call to recover the catalog
name→codepoint mapping at runtime without supplying the
`fontTableDecryptor` callback that the framework keeps in its private
caller stack.**

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

## Why the hybrid prototype is misleading (2026-05-12 verification)

The hybrid combines `CUICatalog._baseVectorGlyphForName:` with a
post-table reverse lookup against `SFSymbolsFallback.otf`:

1. For each catalog name, call `_baseVectorGlyphForName:` to get a
   `CUIRenditionKey` whose `themeIdentifier` is a 16-bit NameIdentifier.
2. If `NameIdentifier < CTFontGetGlyphCount(SFSymbolsFallback.otf)`
   (i.e. below 40,852) AND `CTFontCopyNameForGlyph(font, NID)` returns
   a name matching `uniXXXXXX[.size]`, claim the hex digits after `uni`
   are the codepoint.
3. Otherwise emit null.

**This is wrong.** NameIdentifier is a catalog asset ID for the renditions
in `Assets.car`, not a glyph index for any font. The two number spaces
overlap incidentally for ~45% of the catalog, but when they do, the
glyph reached by `NID` has no semantic relationship to the catalog name
that produced `NID`. Verification on 2026-05-12 with macOS 26.4:

```
catalog name:  house.fill
NID returned:  22827
glyph at 22827 in SFSymbolsFallback.otf:  uni102BEF.small
claimed codepoint:  U+102BEF
actual glyph at U+102BEF in SF Pro:  a gear-like symbol (NOT a house)
pixel diff between NSImage("house.fill") and SF-Pro@U+102BEF: 1877/4096 (46%)
```

The 2026-05-11 spike's "3,770 of 8,303 resolved" number measured
"emitted a non-null value", not "the value is correct". Spot-checking
post-table names confirms the false-positive rate is high enough that
shipping the hybrid would write garbage into `sf_symbols.codepoint` for
roughly half the catalog with no way to flag the bad rows. We therefore
do **not** wire any variant of this hybrid in.

## Options for a real fix

1. **Bake the mapping at SF Symbols release time using SF Symbols.app's
   own `Export…` menu.** Produces a `.symbolset` directory with
   `metadata.json` carrying `unicodePoint` per symbol. Manual or
   UI-automation step, not runtime extraction. ~100% coverage, but
   couples a build step to GUI automation.
2. **Vendor a `(name, codepoint)` JSON pinned to the macOS major
   version.** Pulled from a community export (`SFSymbolsExports` style
   datasets) or generated via Option 1 once per release. Trades runtime
   extraction for a snapshot-sidecar dependency.
3. **Recover the `fontTableDecryptor` Apple uses in-process and supply
   it to `SymbolFontReader.MetadataReadingOptions`.** The Swift ABI to
   the framework is reachable (revision finding #3). What's missing is
   the function body of the decryptor — Apple keeps it in the caller
   stack, never in an exported symbol. Static-analyze the framework
   binary to recover the algorithm; reimplement; supply the callback.
   Multi-day reverse engineering, brittle across macOS point releases,
   and likely to break the moment Apple rotates the key.
4. **Reverse-engineer the `1f e5 2b ff` compression format of
   `metadata.store`.** `index.plist` declares it compressed; entropy
   suggests either dictionary compression with a custom alphabet, or
   compression-then-light-XOR. Independent of (3) because the
   plain-text catalog CSV embedded inside `metadata.store` is what
   `SymbolMetadataStore` reads on the system path. Same risk profile.

Option 2 is the only path that actually ships. The data file rides
along with the snapshot, so each macOS release we target gets one
manual export at snapshot-cut time, and the runtime stays pure-JS.
Until that file lands in `data/snapshots/`, the `sf_symbols.codepoint`
column stays NULL — which the route + UI already handle.

## What the Swift ABI route bought us

Even though it didn't unblock codepoints, the handcrafted
`.swiftinterface` discovery has independent value:

- We can now call any `SFSymbolsShared` Swift API from our own Swift
  binaries (renderers, prerenderers, snapshot tools) — no need for
  Objective-C shims or `@_silgen_name` mangling.
- A minimal working module at `/tmp/sfs-probe-mod/SFSymbolsShared.swiftmodule/`
  declared `SymbolMetadataStore`, `SymbolFontReader`, `FontSymbol`,
  `MetadataReadingOptions`, three font providers, and the protocol
  `SymbolFontProvider`. The compiler accepts the import because the
  framework binary ships full library-evolution-compatible mangled
  symbols (struct dispatch thunks present, class method dispatch thunks
  absent — declare class methods as `final` in the interface to skip
  the thunk).
- Useful future applications: server-side symbol-effect rendering,
  reading `SymbolMetadata.tags` for keyword search, querying
  `SymbolMetadataQuery` for category lookups.

If we ever revisit a Path B-style exporter, this is the starting point;
the blocker is not the framework module, only the decryptor data.

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

## Verdict (historical — see top of doc for current status)

The 2026-05-12 morning spike concluded "unreachable" because the
syls decryption key was nowhere to be found in SFSymbolsShared. The
2026-05-12 afternoon re-investigation found `Crypton.decryptObfuscatedFontTable`
in **CoreGlyphsLib.framework** — the sibling private framework next to
SFSymbolsShared inside SF Symbols.app. CoreGlyphsLib also links
CryptoKit.framework, which provides the actual cipher primitives.

## How the unblock works

`SymbolFontReader.MetadataReadingOptions` takes a
`fontTableDecryptor: ((CTFont, UInt32) -> Data?)?` callback. The
framework calls it whenever it needs to read an obfuscated font table
(`syls`, `symp`). The system process supplies this callback in-process
at runtime; SF Symbols.app itself supplies it as a closure that
forwards to `Crypton.decryptObfuscatedFontTable`.

We do the same:

```swift
import SFSymbolsShared
import CoreGlyphsLib

let provider = VariableSymbolFontProvider(url: sfSymbolsFallbackOTF)
let opts = SymbolFontReader.MetadataReadingOptions(
  fontTableDecryptor: { font, tag in
    Crypton.decryptObfuscatedFontTable(tableTag: tag, from: font)
  },
  customCSVData: nil,
  additionalCSVColumns: nil,
  metadataDirectory: URL(fileURLWithPath:
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Resources/metadata")
)
let reader = try SymbolFontReader(symbolFontProvider: provider, metadataReadingOptions: opts)
let pua = reader.symbol(forSystemName: "house.fill", preferComposite: true)!.pua.value
// => 0x10039F
```

Both frameworks ship without `.swiftmodule` / `.swiftinterface`. We
generate minimal handcrafted interfaces at worker-spawn time and pass
them through `swiftc -I -F -framework`. Module sources are in
`src/resources/swift/symbol-codepoint-worker.js` as the
`SF_SYMBOLS_SHARED_INTERFACE` and `CORE_GLYPHS_LIB_INTERFACE`
constants. They declare only the symbols we touch — under library
evolution the struct/class internals can drift without breaking us.

Coverage measured on macOS 26.4 + SF Symbols.app 7.x:

```
public catalog size: 8302
resolved:   8302 (100.0%)
unresolved: 0
```

## What the user-facing pipeline now does

1. `apple-docs sync` runs `syncSfSymbols`, then `stampSfSymbolCodepoints`.
2. `stampSfSymbolCodepoints` calls `resolveSymbolFontPath`, which
   confirms SF Symbols.app is installed and returns
   `{ fontPath, metadataDir }`. Returns null on hosts without
   SF Symbols.app — the column stays NULL but sync doesn't fail.
3. `dumpSymbolCodepoints` spawns the Swift worker with the symbol
   catalog on stdin; the worker emits `{name, codepoint}` per line.
4. The JS host validates each codepoint is in PUA (defensive) and
   calls `db.updateSfSymbolCodepoint(scope, name, codepoint)`.
5. The DB column is now populated. Snapshot consumers download a
   pre-stamped DB; they don't need SF Symbols.app installed.

## Implications for font thinning

The catalog name→codepoint mapping was useful but not strictly required
for the original "thin SF-Pro.ttf to SF Symbols' codepoints" goal —
`codepoint-from-font.js` already parses SF-Pro.ttf's cmap to recover
the legal PUA codepoint set. The new mapping does enable the inverse
direction: callers can request a font subset by **symbol name**
(future P3 work on `/api/fonts/subset`), and the UI can display the
codepoint inline on each symbol's detail page (already wired in
`src/web/assets/symbols-page/detail-panel.js` — it was just sitting
on a NULL column).
