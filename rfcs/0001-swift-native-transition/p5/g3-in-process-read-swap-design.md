# G3 — in-process read-swap (the real F3): design + sequencing

- **Status**: Design / NOT started — gated on a payoff measurement (see §1).
- **Date**: 2026-06-21
- **Parent**: [RFC 0001](../../0001-swift-native-transition.md) P5 (storage); [p5/records.md](records.md).
- **Owns**: making the search `Cascade` serve reads from the **ADDB engine in-process**
  (rows born in Swift, no FFI) behind a composition-root flag, with per-query SQLite-oracle
  parity. The proven exemplar is `searchPagesDenormRows` (`ADSQLSearch/SearchProjectionRow.swift`).

> Why a design doc and not a patch: G3 is architecture-level, touches the most actively-edited
> files (`Cascade`, `ADStorage`, `ADServer/{Main,AppConnection}`), is **"no correct partial"**
> (the cascade threads ONE concrete connection type through every tier), and its payoff is
> **unproven** — P5 measured FFI reads 7–16% *slower* than `bun:sqlite`, and the entire G3 thesis
> is that the in-process ADDB path (no FFI) reverses that. None of that is verifiable on a host
> without a real corpus. The correct first move is to **prove the payoff**, then execute the
> sequenced refactor below. Rushing the refactor before the measurement repeats P5's NO-GO risk.

## 1. The hard gate — prove the in-process win BEFORE the refactor

The user-visible value of G3 is **lower search latency when serving in-process**. P5 already
shipped a byte-parity native read path and shelved it because FFI made it slower. G3 must clear
the bar P5 could not:

**Gate G3-0 (blocking): on a real `ADSQLImport`-produced snapshot, the in-process ADDB FTS read
(`searchPagesDenormRows`, no FFI) must beat the `bun:sqlite`/libsqlite3 path at p50 and p95.**

- Build an `_addb-read-spike` verb (mirroring the existing hidden `_addb-write-spike`) that, given
  a snapshot path, runs N iterations of the denorm FTS query through **(a)** ADDB
  `Statement`/`searchPagesDenormRows` and **(b)** ADStorage's libsqlite3 `ftsRows`, and prints the
  latency distribution for each. Reuse `ADSQLImport.importSQLite` to produce the ADDB snapshot from
  the live SQLite corpus.
- **GO** → execute §3. **NO-GO** (ADDB in-process ties or loses) → stop; record it like P5's F-track
  NO-GO. The denorm read primitives still stand on their own (structured rows, the FTS exemplar);
  only the *flip* is abandoned.

This gate is cheap relative to the refactor and is the single most important G3 task.

## 2. Verified architecture (the facts the design rests on)

Mapped 2026-06-21 against the sources (not memory):

- **No seam exists.** `StorageConnection` is a `final class` (no protocol), holding a concrete
  `Connection` (dlopen'd libsqlite3 + statement cache). `Cascade` is **not** generic — every entry
  point takes a concrete `StorageConnection` (`Cascade.swift` `search`/`assemble`/`assembleOutcome`).
- **The cascade's read surface is ~10 methods, not 45.** Across all tiers + relaxation + enrich +
  framework expansion, `Cascade.swift` calls exactly: `getFrameworkSynonyms`, `titleExactRows`,
  `ftsRows`, `trigramRows`, `searchRecordsByIds`, `bodyRows`, `getDocumentSnippetData`,
  `getRelatedDocCounts` (≈8 distinct; `ftsRows`/`trigramRows` recur in R1–R3 relaxation). The
  **~45** figure in the plan is the *whole in-process server* surface (read_doc, browse, status,
  assets, corpus-stats, framework-tree, taxonomy, …) — needed for G4's full ad-server, **not** for
  the search cascade. **Scope G3 to the cascade first**; the rest follows once the seam + the win
  are proven.
- **The ADDB read API**: `Database.open(at:options:)` → `prepare(_:) -> Statement` →
  `Statement.all/get/forEach(_: SQLParameters) -> [SQLRow]` → `SQLRow.decode() -> RowDecoder`
  (by-name `text/int/double/blob/isNull`). `searchPagesDenormRows` is `prepare(denormSQL).all(…).map { SearchProjectionRow($0.decode()) }`
  — the FTS tier already done, structured, and parity-tested vs `searchPagesFramedDenorm`.
- **Only the FTS tier has an ADDB query.** Title-exact, trigram, fuzzy-by-id, and body tiers have
  **no** ADDB SQL yet — each needs a denorm-style query + bindings + a `*Rows`-shaped decoder, then
  per-tier parity. This is the bulk of the new code.

## 3. Seam decision — protocol + generic cascade (recommended)

Two options were weighed:

- **(a) `StorageReading` protocol + generic `Cascade`** — one implementation per backend
  (`StorageConnection` conforms trivially; a new `ADDBSearchReader` implements the ~8 methods over
  `Database`/`Statement`). `Cascade.search<R: StorageReading>(_ conn: R, …)`.
- **(b) Dual-backed `StorageConnection`** — an internal `enum Backend { case sqlite(Connection); case addb(Database) }`
  with a `switch` in each method; callers unchanged.

**Recommend (a)**, scoped to the cascade's ~8 methods (a *lean* protocol, not all 45):

- It is the honest model — two real backends, swappable at the composition root, each written once.
- It makes the **parity test trivial**: run the same `SearchParams` through a `StorageConnection`
  and an `ADDBSearchReader` over the same corpus and assert multiset-equal rows (and FTS MATCH
  docid order) — per method and end-to-end.
- (b) doubles every method body inside one class, couples the SQLite and ADDB lifetimes, and still
  needs the same per-tier ADDB SQL — the duplication without the clean seam.

Cost of (a): `Cascade`'s entry points become generic (or take `any StorageReading`), rippling to
`ADServer`/`ADCLI` call sites. That ripple is the "no correct partial" — it lands in one change,
behind the flag, with the SQLite path as the default until Gate G3-0 says flip.

## 4. Sequenced plan (each step independently verifiable)

1. **G3-0 (gate)** — `_addb-read-spike` + measurement on a real snapshot. GO/NO-GO. *(blocks all below)*
2. **Reader skeleton** — `ADDBSearchReader` (new file, holds a `Database`), implement `ftsRows`
   via `searchPagesDenormRows`. Parity test vs `StorageConnection.ftsRows` on an `ADSQLImport`
   snapshot. *Additive — touches no contended file.*
3. **Remaining tiers** — write the ADDB denorm SQL + `*Rows` decoders for title-exact, trigram,
   fuzzy-by-id, body; one parity test per tier (multiset + FTS docid order vs the SQLite oracle).
   *Still additive.*
4. **The seam** — extract `protocol StorageReading` (the ~8 methods); `StorageConnection` conforms
   (no behavior change); make `Cascade` generic over it. *This is the contended-file change — do it
   on a stable tree, in one commit.*
5. **Flag + wiring** — `--use-addb` on `ServeCommand`/`ADCLI`; `AnyConnectionPool.addb(path:)` in
   `AppConnection`. Default OFF.
6. **End-to-end parity** — `ad-server`/`ad-cli --use-addb` on an `ADSQLImport` snapshot, exercising
   the MCP tools; assert byte/intrinsic parity vs the SQLite path; record latency vs SQLite.
7. **Flip (only if 1 + 6 are green)** — make ADDB the default for in-process serving; keep SQLite as
   the escape hatch. Then extend `StorageReading` to the other ~35 methods for the full ad-server
   read surface (G4).

## 5. Parity strategy

- **Oracle**: the existing libsqlite3 `StorageConnection` over the same corpus is ground truth.
- **Per method**: multiset-equal rows; for FTS tiers also assert the **MATCH docid order** (bm25
  rank ties resolve by docid — must match). `searchPagesDenormRows`'s equivalence vs
  `searchPagesFramedDenorm` (`SearchDenormEquivalenceTests`) is the template.
- **End-to-end**: the cascade's framed `[UInt8]` output must be byte-identical between backends; the
  search eval (NDCG/MRR) unchanged.

## 6. Risks / coordination

- **Contended files** (`Cascade`, `ADStorage`, `ADServer/{Main,AppConnection}`) are edited by the
  owner concurrently. Steps 1–3 are additive (safe anytime); step 4 (the seam) must land on a stable
  tree in one commit to avoid clobbering in-flight work — coordinate before starting it.
- **Unproven payoff** — §1 is the whole risk. If ADDB in-process does not beat SQLite, G3 is a P5-style
  NO-GO and only the (already-shipped) read primitives survive.
- **ADDB Linux portability (Track H)** is orthogonal to G3 but gates G4's cross-platform release; G3
  can be proven + flipped on macOS first.
