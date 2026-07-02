// The S5 highlight seam: a long-lived JSONL coprocess around shiki
// (operator decision #2 — precompute highlighting at BUILD time, keeping
// shiki as a build-only subprocess; it never runs at serve time).
//
// ad-cli spawns `bun scripts/highlight-server.ts` once per build, writes one
// JSON request per line on stdin, and reads one JSON response per line from
// stdout:
//
//   → {"id":1,"code":"let x = 1","lang":"swift"}
//   ← {"id":1,"html":"<pre class=\"shiki ...\">…</pre>"}     (or "html":null)
//
// The FIRST line out is the readiness handshake `{"ready":true}` (grammars
// are warmed by initHighlighter before any request is answered). Requests
// are answered strictly in arrival order.
//
// Behavior identity with the bun static build is BY CONSTRUCTION: this
// imports the very `highlightCode` the JS renderer calls (same LANG_MAP,
// same 8 KB APPLE_DOCS_HIGHLIGHT_MAX guard, same APPLE_DOCS_NO_HIGHLIGHT
// kill-switch, same LRU + theme set), so a given (code, lang) produces the
// same html — or the same null fallback — on both sides.

import { highlightCode, initHighlighter } from '../src/content/highlight.js'

await initHighlighter()
console.log(JSON.stringify({ ready: true }))

const decoder = new TextDecoder()
let pending = ''

for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true })
  let newline = pending.indexOf('\n')
  while (newline !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    newline = pending.indexOf('\n')
    if (line.trim().length === 0) continue
    let response
    try {
      const request = JSON.parse(line)
      const html = highlightCode(request.code, request.lang)
      response = { id: request.id, html: html ?? null }
    } catch (error) {
      response = { id: null, html: null, error: String(error) }
    }
    console.log(JSON.stringify(response))
  }
}
