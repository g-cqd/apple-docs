# Audit 2 — Strict Architectural Review

**Date:** 2026-05-09
**Scope:** subtle architectural flaws, "pessimizations," and security edge cases that would only surface under high load or malicious input.

## Security & Robustness Audit

### 1. The "Wedge" Risk: Hand-Rolled Parsers

The project uses a hand-rolled regex-based HTML/Markdown parser (`src/content/parse-html.js` and `src/content/render-html.js`).

- **ReDoS Vulnerability:** The heavy use of non-greedy patterns like `[\s\S]*?` and `.*?` within nested logic is a Denial of Service (DoS) vector. While some "wedges" were historically fixed, the architecture is inherently fragile. A single complex document with mismatched tags could bypass the `MARKDOWN_MAX_BYTES` cap and hang the JS thread.
- **Broken Timeout Logic:** `renderWithTimeout` uses `Promise.race` with `setTimeout`. Because JavaScript is single-threaded, if a synchronous regex or parser loop "wedges" the thread, the timeout will never fire. The event loop must be free to execute the timeout callback; if it's pinned by a parser, the process is effectively dead.
- **Nesting Inefficiency:** `stripElements` uses a `do...while` loop with regex replace to handle nesting. This is `O(N²)` relative to nesting depth. A malicious HTML payload with 1,000 nested `<div>` tags would cause a significant performance hit.

### 2. Resource Exhaustion & Memory Safety

- **Fuzzy Search RAM Pressure:** `fuzzyMatchTitles` builds a global `_trigramCache` in-memory. For a 350K document corpus, this cache can consume several hundred megabytes of RAM. In a multi-worker setup (e.g., `--workers 8`), this memory cost is multiplied per process, risking Out-Of-Memory (OOM) crashes on systems with < 8GB RAM.
- **JSON Recursion Stack Limit:** `src/content/safe-json.js` uses a recursive `freezeJsonValue` function. A deeply nested JSON structure (which can be valid but malicious) will trigger a `RangeError: Maximum call stack size exceeded`, crashing the worker or MCP server.

## Performance & Scalability Audit

### 1. O(N²) Queue Management

The core utilities pool (`src/lib/pool.js`) and `RateLimiter` (`src/lib/rate-limiter.js`) use `Array.prototype.shift()` to manage their queues.

- **The Problem:** In JavaScript, `shift()` is an `O(N)` operation because it requires re-indexing the entire array.
- **The Impact:** During a full rebuild of 350K documents, the pool will call `shift()` 350,000 times on a large array. This results in `O(N²)` overall complexity, where the system will spend an increasing amount of time just managing the task queue rather than performing work.

### 2. GC Pressure in Hot Paths

- **Levenshtein Allocations:** The `levenshtein` function in `src/lib/fuzzy.js` allocates a new array `Array.from({ length: n + 1 })` on every call. During a search, this can be called thousands of times per second, leading to massive Garbage Collection (GC) pressure and "jank" in the MCP server response times.
- **Recursive Freezing:** `safeJson` recursively freezes every JSON blob read from the database. This is a CPU-intensive operation that adds latency to every document read, even for documents that are already safe/trusted.

## Architectural Technical Debt

### 1. Path Traversal: "Defense in Depth" Gap

`src/lib/safe-path.js` and `keyPath` do not validate that the resulting path remains within the intended `dataDir`. While the system is currently protected because keys are retrieved from a "trusted" SQLite DB, the lack of sanitization at the utility level is a latent security risk. If a future "sync" provider were compromised and inserted `../../etc/passwd` into the DB, the lookup command would attempt to read it.

### 2. Fragile Markdown Implementation

The custom Markdown parser is extremely minimal and does not follow the CommonMark spec. It will fail to correctly render:

- Nested lists with mixed indentation.
- Code blocks inside list items.
- Complex link/image combinations.

This results in degraded documentation quality for complex technical specs like Swift Evolution proposals.

## Strategic Recommendations

1. **Replace Hand-Rolled Parsers:** Migrate to `linkedom` for HTML parsing and `micromark` for Markdown. These are spec-compliant, faster, and hardened against ReDoS.
2. **Optimize Queues:** Replace `Array.shift()` with a proper linked list or double-ended queue (Deque) in `pool` and `RateLimiter` to move from O(N) to O(1).
3. **Harden Recursion:** Use iterative logic for `freezeJsonValue` to avoid stack overflows.
4. **Memory Management:** Implement a smarter `_trigramCache` that uses a `Buffer` or typed array instead of a Map of thousands of objects to reduce memory overhead and GC pressure.
5. **Path Sanitization:** Add a `path.normalize()` and a "is within dataDir" check to `keyPath` to ensure filesystem operations are strictly jailed.
