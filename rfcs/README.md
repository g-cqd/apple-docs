# RFCs — the Swift-native transition roadmap

Living index. Phase definitions live in
[RFC 0001](0001-swift-native-transition.md); this file holds the CURRENT
sequencing, which RFC 0001 §7 points at. Repo documentation only — not
built or indexed by the docs site.

## RFC index

| RFC | Carries | Status |
| --- | --- | --- |
| [0001 — Swift-native transition](0001-swift-native-transition.md) | The master plan: phases P0–P7, bridge architecture, dependency policy, **§10 improvement track** | Living |
| [0002 — Swift embedder](0002-swift-embedder.md) | P2 | **COMPLETE** (2026-06-12, Stage C: default model native-only, snapshots ship ADMX, transformers demoted to gated models; §6h: embedding v2 + reference flip executed) |
| [0003 — Swift render service](0003-swift-render-service.md) | P3 | **Phases 1, 2, 4 EXECUTED (2026-06-13)**. darwin: `render` default-on for every render — font-text + symbol-pdf + symbol-png (query, 163×/1497× over JIT) + the symbol prerender (`ad_render_symbol_pdf_batch`, 2.0× over the pool, RSS bounded); D-0003-3 settled SAFE (concurrent AppKit + NSBitmap PNG). **Linux (phase 4)**: `HarfBuzzShaper` dlopens libharfbuzz (HB draw API, no FreeType) → **hb-view host binary dropped**; spike GO at 0–1.1% supersampled diff vs hb-view (D-0003-2 settled). Only phase 3 (darwin spawn-script kills) remains — held on the §4 release-cycle gate |
| [0004 — Swift content pipeline](0004-content-pipeline.md) | P4 | **Main line DONE** (2026-06-12/13): phases 1-2 + §6b perf round → `content` default-on (parity at corpus scale, every perf gate met); phases 3-4 closed **NO-GO** by the §6c static-build profile (build is IO-bound, render ~6%). Phase 3 = separate crawl-time question |

## Evidence behind the current order (measured 2026-06-12)

- **Query latency** (372 ms natural-language p50, full corpus): ~99%
  inside SQLite C (`Statement.all` 78% / `.get` 21%); JS orchestration
  ≈0.5%. Porting query-path JS wins nothing on latency — SQL-layer
  IMPROVEMENTS do (RFC 0001 §10 (B)).
- **Build time**: content conversion ≈27 ms/page × ~358k pages — hours of
  JS+shiki CPU per full build. The dominant remaining port payoff (P4).
- **Render one-shots**: ~200 ms JIT spawn, paid only on cache-miss query
  paths (P3-darwin's case).
- **Operational**: ~3 s event-loop stall at burst onset; healthz shares
  the waiting-room 503s
  ([runbook](../ops/runbooks/mcp-burst-healthz.md)) — §10 (C).

## Current tracks

**Main line**
1. ~~**Embedding v2**~~ — **DONE 2026-06-12** (RFC 0002 §6h): astral-CJK
   fix + rounding change, order/VS16 retained on evidence; reference
   flip executed (Swift is its own reference; transformers.js =
   divergence recorder); `embed_version` coordination landed.
2. ~~**RFC 0004 + P4 content pipeline**~~ — **DONE for the main line**.
   Phases 1-2 + §6b perf round (2026-06-12): tape parser + parallel
   batches → `content` default-on, byte-proven at 358k-doc scale.
   Phases 3-4 **closed NO-GO by the static-build profile** (2026-06-13,
   §6c/D-0004-8): the build is 84% filesystem IO + 6.5% SQLite; render
   surfaces are ~6% (mostly shiki WASM) → a render port can't move build
   wall-time, IO parallelism (shipped) does. Phase 3 (crawl-time
   normalize) is a separate, independently-gated question.

**Main line advances → pick the next slice** (all independent; the P4
gate is closed):
- **§10 (B) SQLite query round-trips** — the only lever on the
  user-facing 372 ms p50 (~99% in SQLite); a confirmed N+1
  (per-result snippet + related-count fetch) is the concrete target.
- **P3-darwin** (RFC 0003 phases 1-3) — the side slice that gates P5;
  kills ~200 ms JIT spawn per cache-miss render.
- **§10 (C) burst-stall + healthz** / **(E) snapshot size** — smaller
  operational improvements.

**Side slice (parallel)**
- **P3-darwin** (RFC 0003 phases 1–3): render exports + dispatch behind
  `render`, prerender switch, darwin spawn-script kills.

**Improvement slices (RFC 0001 §10 registry — evidence-gated, schedule
opportunistically)**
- ~~(B) SQLite query-layer round-trips~~ — **DONE 2026-06-13**: a
  per-search `COUNT(*)` over the 358k-row body-FTS index was 43% of
  search CPU; an existence probe + count memoization cut p50 **2.5–5×**
  with recall/ndcg/mrr byte-flat (RFC 0001 §10 (B)). · (C) burst-stall
  architecture + healthz liveness exemption · (E) snapshot/storage size ·
  (F) chunking parameters (separate eval; may ride (A)'s re-embed).

**Deferred bucket (explicit, revisit-triggered)**
- RFC 0003 phase 4: Linux HarfBuzz/FreeType shaper + the hb-view kill —
  triggers: Linux-host friction with hb-view, or P7's single-binary
  requirement. hb-view keeps serving Linux meanwhile.
- P7 musl/static-Linux work (per RFC 0001 §5).

**Tail (order unchanged)**
- **P5 storage** — gate: P2 ✓ + P3-darwin native-by-default. D4
  (swift-structured-queries vs raw C interop) decided in its design.
- **P6 servers** — **fully custom in-house on SwiftNIO** (D1 settled
  2026-06-12: no Vapor; deps stay apple/* + swiftlang/* + pointfreeco/*
  only).
- **P7 final binary** — single Swift executable, Bun retired.

## Doctrine pointers

- Parity-first porting + per-module kill switch: RFC 0001 §4.
- **Beyond parity** (bug fixes, performance, quality — the two-step rule,
  five-category gate matrix, reference-flip rule, candidate registry):
  RFC 0001 §10.
- Dependency policy (apple/swiftlang/pointfreeco + system C libs;
  exception mechanism): RFC 0001 §2.

*Maintenance*: update this file whenever a track starts/finishes or the
order changes; dated detail belongs in the owning RFC's records.
