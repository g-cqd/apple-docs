# MCP healthz under burst — characterization (2026-06-11, mm18)

Smoke's concurrency probe (16× search_docs staggered 10 ms) reports healthz
failures like `0/5 2xx [timeout timeout 503 503 503]`. Measured on mm18
(Intel, native modules on) with a 0.7 s sampler around a live burst:

| Phase | Behavior |
| --- | --- |
| Pre-burst | 200 in ~58 ms |
| Burst onset (~3 s) | TRUE event-loop stall — one probe cut at the 3 s curl deadline, one served after 2.9 s. The first wave of 16 cache-miss searches stacks synchronous main-thread work (FFI calls, JSON serialization) before the queue machinery spreads it. |
| Saturation (rest of burst, ~10 s on Intel) | Fast **deliberate 503s in ~55 ms** — the waiting-room backpressure (src/mcp/http-server.js:249, depth > 64 → 503 + `Retry-After: 1`) applies to healthz too; the readiness gate (src/mcp/health-handlers.js:64) can also report 503 by design. |

Conclusions:

- The 503s are **load-shedding working as designed**, not failures — but
  health probes share the backpressure gate, so external monitors read a
  saturated-but-healthy instance as down. The burst itself completed
  16/16 with 0 request failures.
- The only genuine defect-shaped window is the ~3 s onset stall where not
  even a 503 gets out.

Possible follow-ups (separate decisions, NOT taken here):

1. Exempt `/healthz` (liveness) from the waiting room while keeping
   `/readyz`-style semantics on the gated path — monitors stop flapping.
2. Chip at the onset stall (yield points around the synchronous burst
   work) — only worth it if real traffic ever looks like the probe.
3. Teach smoke to count 503-with-Retry-After as "shedding", not failure.

## Update 2026-06-13 (RFC 0001 §10(C), re-measured)

- **#1 is DONE — structurally.** `/healthz` is a sibling route at the
  server origin (`http-server.js:154` returns the health body *before* the
  `/mcp` route and the heavy semaphore), so it never enters the
  waiting-room. The saturation-503-on-healthz symptom is gone; an existing
  unit test guards it. #3 is therefore moot for healthz (it returns 200,
  not 503).
- **The onset stall did not reproduce.** A 16× `search_docs` burst against
  the real `startHttpServer` over the full 831k-chunk DB (arm64) held
  healthz at **1 ms, 8/8 200** — no cut. The mm18 figure was Intel + cold;
  arm64's fast native embed plus the §10(B′) 3× semantic-search speedup
  appear to keep the first wave under the probe deadline.
- **Disposition:** #2 (onset yield points) stays **deferred** — its
  operational gate needs evidence on the affected host class (Intel),
  which isn't reproducible here. Revisit only if a prod monitor on that
  host actually flaps. No code change made.
