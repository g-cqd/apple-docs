# RFC 0001 P5 — storage execution records (archive)

Detailed records for the Swift-native storage layer (RFC 0001 §7 P5). Repo
documentation; never built or indexed. Parent:
[RFC 0001 §7 P5](../../0001-swift-native-transition.md).

---

## First slice — foundation + `searchPages` probe — EXECUTED 2026-06-13

### Scope (operator-chosen)

A durable native-SQLite **read** foundation + ONE hot op (`searchPages`)
ported end-to-end behind the bun:ffi bridge, measured for a GO/NO-GO on
whether to flip bridge-era reads native-by-default. NOT the full read-path
port (the other 12 ops, the flip, the kills are P6/P7-coupled). The
bun:sqlite **writer** is untouched.

### Decisions settled

- **D4 → raw C interop**, NOT pointfreeco swift-structured-queries. Parity
  needs the byte-identical hand-tuned FTS5 SQL (`bm25(documents_fts,
  10,5,3,2,1)`, the tier `CASE`, `FILTER_PREDICATES`); a builder risks
  different SQL for zero benefit + a dep. The SQL is duplicated in
  `ADStorage/SearchPages.swift` (pinned to `search.js` by the parity test);
  the filter-param derivation stays the single JS source of truth
  (`buildFilterParams`, exported).
- **Linkage → runtime `dlopen`**, NOT a SwiftPM systemLibrary (the
  `ADArchive/Zstd.swift` policy: a systemLibrary makes libsqlite3 a hard
  build dep and breaks the absent→JS-fallback invariant). ~20 symbols bound
  like `ZstdLib`. Supersedes RFC 0001 §2's "module maps" sketch.
- **Connection model**: `ad_storage_open` → monotonic `u64` handle into a
  `DispatchQueue`-guarded registry (`Mutex` from Synchronization needs
  macOS 15; floor is 13). Each reader worker opens one handle at its serial
  bootstrap; within a worker calls are serial. Opened **READWRITE |
  NOMUTEX** + `PRAGMA query_only=ON` — matches bun:sqlite's reader workers
  (which open `new Database(path)` r/w) so it participates cleanly in the
  WAL `-shm` wal-index, while query_only guarantees no writes.
- **Threading**: the `worker_threads` reader pool STAYS; native execution
  happens INSIDE the worker (blocking FFI on a worker thread is safe). The
  RFC's "reader pool → native actors" needs async FFI and belongs to P6
  (SwiftNIO owns the loop, no FFI). Confirmed: bun:ffi is blocking, so a
  main-thread native call would freeze the event loop.
- **Row transport**: packed binary, per-cell type-tagged (`[u8 tag][value]`,
  0 NULL / 1 i64 / 2 f64 / 3 text / 4 blob) — NOT JSON. Reproduces
  bun:sqlite's dynamic row mapping (null/number/string/Uint8Array) exactly;
  column names implicit (the op's fixed 24-column order), built positionally
  to preserve key order.

### What shipped

- Swift `ADStorage` target (dlopen, zero deps): `SQLiteLib`, `Connection`
  (pragma subset in `pragmas.js` order, busy_timeout first; tier probes;
  FTS5 verified per-connection), `PreparedStatement` (named binds, mandatory
  `reset`+`clear_bindings`), the type-tagged row codec, `ConnectionRegistry`.
- `ADCore/StorageExports.swift`: `ad_storage_open/close/search_pages`
  (contract v0, no-trap). No `EXPECTED_ABI` bump (additive symbols; the
  result-buffer layout is unchanged).
- `src/storage/storage-native.js` dispatch shim (announce-once, `_forceImpl`,
  grow-only Packer, null→JS fallback). **Default OFF** — unlike the other
  modules, blanket `APPLE_DOCS_NATIVE` on/unset does NOT enable `storage`;
  it must be named explicitly. `reader-worker.js` opens a handle at boot and
  routes `searchPages` to native when the handle exists.

### Gate results

1. **A/B byte-parity — PASS.** `test/unit/native/storage-search-pages.test.js`:
   17 query cases (tiers 0-3, every filter, multi-source, deprecated
   include/exclude/only, min_ios, year/track, unicode title, empty, combined)
   × full `toStrictEqual` on every row. Byte-identical including **bm25
   `rank`** — the float is bit-identical between Bun's bundled SQLite and the
   dlopen'd Homebrew/system SQLite (the fts5/bm25 C code is stable across
   versions). Key order + null-vs-undefined + number-vs-string all match.
2. **Concurrency latency — NO-GO (native slower).** `scripts/storage-search-bench.mjs`
   (480 docs / 8 frameworks, an 8-framework "search unit" × 3000 iters,
   arm64): native FFI **p50 1.07× / mean 1.16× SLOWER** than bun:sqlite
   (p50 1.27 vs 1.18 ms). Expected: bun:sqlite is already native C SQLite,
   so the FFI pack+frame+decode is pure boundary tax over the same query —
   exactly the P4 "P7 corollary". The gate is "native ≥ JS"; native loses.
3. **WAL coexistence — PASS.** `test/integration/storage-wal-contention.test.js`:
   4 native read handles + the live bun:sqlite writer, 250 interleaved
   commit→read rounds (2003 assertions) — no SQLITE_BUSY/corruption,
   read-your-writes consistent across the two SQLite builds, WAL bounded
   (< 16 MB; autocheckpoint not starved because each `searchPages` steps to
   DONE and resets, holding no long read cursor).

### FTS5 availability

Required by `searchPages` (bm25 + `documents_fts MATCH`); verified per
`Connection` open (absent → open fails → JS `bun:sqlite` serves, parity
safe). Present via Homebrew/system SQLite on macOS and `libsqlite3-0`
(ships `SQLITE_ENABLE_FTS5`) on Linux; the native tests **skip** (not fail)
where the host's libsqlite3 lacks it. CI installs `libsqlite3-0` on Linux.

### Decision — NO-GO for the bridge-era flip; foundation ships OFF

The native read path is **parity-perfect but ~7-16% slower** per call in the
bridge era, because the win the RFC named (one process, no Worker
marshalling, prepared-stmt reuse) is **P6/P7-coupled**: it only materializes
when there is no FFI boundary and rows are born in Swift memory. The "kills"
(bun:sqlite, the Worker pool) are likewise P7-coupled — you cannot remove
bun:sqlite while it is the runtime AND the writer.

So `storage` stays **token-gated OFF** (`APPLE_DOCS_NATIVE` must name it).
The foundation is NOT wasted: **P6 (the SwiftNIO server) cannot use
bun:sqlite**, so it requires exactly this native read layer; this slice
proves it byte-correct + WAL-safe and inherits batched-or-better economics
once the FFI tax disappears. P5's deliverable is "foundation proven +
measured," not "reads flipped."

### Deferred (later P5 slices / P6)

The other 12 SQL read ops (searchTitleExact/Trigram/Body, getPage,
getDocumentSections [needs a zstd-decompress binding], getSearchRecord*,
getBodyIndexCount, hasBodyIndex, searchByTitle, getTier/SchemaVersion);
`fuzzyMatchTitles` is CPU-bound Levenshtein (not a statement port). The
write path, the reader-pool→native-actors move, and the kills.

### Coordination — ADSQL (CinderViper)

A sibling effort (`/Users/gc/Developer/ongoing/swift/ADSQL`) is building a
from-scratch pure-Swift SQLite engine (own COW-B+tree `ADSQLv0` on-disk
format, MVCC; FTS5 at milestone M5; macOS-26/Apple-Silicon only).
Complementary, not duplicative: it can't read the live **real-SQLite**
corpus the bun:sqlite writer mutates, and apple-docs is first-class Linux.
A future adoption (P7 / a §10 schema-format slice) is gated on ADSQL gaining
FTS5 + bm25, Linux x64/arm64, and a real-SQLite→ADSQLv0 corpus-migration
story. This slice's libsqlite3 binding is the bridge/P6 path regardless.

### G3 design — in-process read-swap on ADDB (2026-06-21)

The "later P5 slice / the real F3" — flipping the search `Cascade` to read from the
**in-process ADDB engine** (no FFI), the architecture this slice's denorm read
primitives (`searchPagesDenormRows`/`RowDecoder`/`SearchProjectionRow`) were built
for. The ADSQL-from-scratch engine referenced above has since become **ADDB** (the
12→8 consolidation), which now ships FTS5/bm25 + JSON + `ADSQLImport` round-trip, so
the adoption blockers listed above are largely cleared on macOS; **Linux durability
(Track H)** remains the cross-platform gate.

Full design + sequencing: [`g3-in-process-read-swap-design.md`](g3-in-process-read-swap-design.md).
**Headline:** the effort is gated on **Gate G3-0** — first *prove* the in-process ADDB
FTS read beats libsqlite3 at p50/p95 on a real snapshot (an `_addb-read-spike`, mirroring
`_addb-write-spike`), because P5 measured FFI reads *slower* and G3's entire payoff is that
the no-FFI in-process path reverses that. GO → execute the additive reader + per-tier parity
+ the `StorageReading` seam + `--use-addb` flag; NO-GO → shelve the flip like P5's F-track,
keeping the (shipped) read primitives. The cascade's real read surface is **~8 methods** (not
the ~45 of the whole server); only FTS has an ADDB query today — the other tiers' denorm SQL
is the bulk of the new code.

### G3-0 gate RUN — NO-GO (2026-07-02)

Built the `_addb-read-spike` verb (hidden, `Sources/ADCLI/AddbReadSpike.swift`) and ran the
gate on a **release** `ad-cli` (a debug run was discarded as unfair — libsqlite3 is optimized
C regardless of our build mode) against a clone of the live corpus (`~/.apple-docs`,
350 K documents):

- Snapshot: `ADDBImport.importSQLite` (documents + roots only; `documents_fts` reconstructed
  `porter unicode61` from `documents.[title, abstract_text, declaration_text, headings, key]`;
  the v28 denorm columns + roots lookup from the DenormImportTests manifest). Import took
  **405 s** release (one skipped index: `idx_documents_usr`, key 1033 B over the engine's key
  limit — harmless for search). ADDB file: 1.24 GB.
- Measurement: 200 iterations/backend/probe, 20 warmup, limit 25, per-iteration A/B
  alternation. `searchPagesDenormRows` (ADDB, denorm, no JOIN/LOWER) vs
  `StorageConnection.ftsRows` (libsqlite3, normalized §2.2).

| probe | ADDB p50 | SQLite p50 | p50 ratio | p95 ratio |
|---|---|---|---|---|
| view | 88.1 ms | 16.0 ms | 5.5× | 5.9× |
| button | 21.0 ms | 3.9 ms | 5.5× | 5.2× |
| async await | 1.62 ms | 0.72 ms | 2.3× | 2.2× |
| urlsession | 1.36 ms | 0.47 ms | 2.9× | 2.3× |
| navigation stack | 1.60 ms | 0.78 ms | 2.1× | 2.1× |

**Pooled: ADDB p50 2.06 ms / p95 125.2 ms vs SQLite p50 1.03 ms / p95 18.4 ms → p50 2.0×,
p95 6.8× — NO-GO on the pooled gate AND on every probe** (gate: GO iff ADDB p50 <
0.97×SQLite AND p95 ≤ SQLite). The gap widens with candidate volume ("view"/"button" — the
broad-match probes), pointing at bm25 scan/merge cost in the engine, not the denorm shape
(the denorm columns removed the JOIN/LOWER work and it still loses).

**Decision (per the gate's own terms): the read-flip track (B1–B5) is SHELVED, exactly like
P5's F-track.** The shipped denorm primitives (`searchPagesDenormRows`, `RowDecoder`,
`SearchProjectionRow`, `prepareForDenormServing`, the import manifest) stand on their own;
serving stays on libsqlite3. Re-open only after an ADDB engine-level FTS/bm25 win is
demonstrated on this same spike (the harness is committed and rerunnable:
`ad-cli _addb-read-spike --db <corpus clone> --snapshot <path>`).
