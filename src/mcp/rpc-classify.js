// Heavy/light JSON-RPC classifier for the MCP HTTP transport.
//
// Lives in a sibling module so `http-server.js` stays under the
// 400-line ceiling. The single export is re-exported from the parent
// for the existing import path.

// Heavy = tools/call requests that may saturate the event loop. The
// MCP HTTP server gates these through a permit semaphore so cheap
// protocol traffic (initialize, ping, tools/list) never waits behind
// a burst of heavy calls from another client.
//
// `list_frameworks` and `list_taxonomy` are intentionally NOT heavy:
// they are cache-wrapped with static/near-static payloads (taxonomy is
// invalidated only after a corpus refresh) and their uncached miss
// path is a small bulk SQL read, not CPU-bound ranking work.
export const HEAVY_TOOLS = new Set(['search_docs', 'read_doc', 'browse', 'search_sf_symbols', 'render_sf_symbol', 'render_font_text'])

/**
 * Classify a JSON-RPC POST payload as 'heavy' (a tools/call that may saturate
 * the event loop) or 'light' (everything else: initialize, ping, tools/list,
 * resources/*, notifications/*, malformed). Unknown or unparseable payloads
 * are treated as light — the transport will produce the right error, and we
 * would rather not throttle on data we can't interpret.
 */
export function classifyRpcPayload(bodyText) {
  if (!bodyText) return 'light'
  let parsed
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return 'light'
  }
  if (Array.isArray(parsed)) {
    // JSON-RPC batch: throttle if any sub-call is heavy.
    return parsed.some((item) => isHeavyRpc(item)) ? 'heavy' : 'light'
  }
  return isHeavyRpc(parsed) ? 'heavy' : 'light'
}

function isHeavyRpc(message) {
  if (!message || typeof message !== 'object') return false
  if (message.method !== 'tools/call') return false
  const name = message?.params?.name
  return typeof name === 'string' && HEAVY_TOOLS.has(name)
}
