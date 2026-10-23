// Request-shape policy for the stateless MCP Streamable HTTP endpoint.
//
// The server is stateless and answers every POST with a single JSON body
// (enableJsonResponse), so it offers no server-initiated SSE stream and no
// sessions to terminate. The MCP transport spec says a server that does not
// offer an SSE stream on GET SHOULD answer 405, and the same holds for
// DELETE without sessions. JSON-RPC batching was removed from the spec in
// 2025-06-18.

/** First protocol revision whose clients never send JSON-RPC batches. */
export const BATCHING_REMOVED_IN = '2025-06-18'

const PROTOCOL_VERSION_RE = /^\d{4}-\d{2}-\d{2}$/
const EMPTY_BATCH_RE = /^\[\s*\]/

/** Methods the `/mcp` endpoint serves (plus OPTIONS for CORS preflight). */
export const ALLOWED_METHODS = 'POST, OPTIONS'

function jsonRpcError(code, message, status, headers = {}) {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status, headers })
}

/**
 * Immediate 405 for GET/DELETE (and any other method) on `/mcp`.
 * Answering at once, instead of opening a stream that never produces an
 * event, stops parallel GETs from holding edge and backend sockets.
 *
 * @returns {Response}
 */
export function methodNotAllowedResponse() {
  return jsonRpcError(-32000, 'Method not allowed. Use POST.', 405, { Allow: ALLOWED_METHODS })
}

/**
 * Reject JSON-RPC batch requests the negotiated protocol no longer allows.
 *
 * A batch is accepted only when the client declares, in `MCP-Protocol-Version`,
 * a revision older than {@link BATCHING_REMOVED_IN}. A missing or malformed
 * header is rejected: a compliant client sends the header on every request
 * after `initialize`, and `initialize` may never be part of a batch. An empty
 * array is invalid JSON-RPC under every revision.
 *
 * @param {string} bodyText  Raw request body.
 * @param {string | null} protocolVersion  Value of `MCP-Protocol-Version`.
 * @returns {Response | null} A 400 response to return, or null to continue.
 */
export function rejectUnsupportedBatch(bodyText, protocolVersion) {
  const trimmed = bodyText.trimStart()
  if (!trimmed.startsWith('[')) return null
  if (EMPTY_BATCH_RE.test(trimmed)) {
    return jsonRpcError(-32600, 'Invalid Request: empty batch.', 400)
  }
  const declared = protocolVersion != null && PROTOCOL_VERSION_RE.test(protocolVersion)
  if (declared && protocolVersion < BATCHING_REMOVED_IN) return null
  return jsonRpcError(
    -32600,
    `Invalid Request: JSON-RPC batching is not supported (removed in MCP ${BATCHING_REMOVED_IN}). Send one request per POST.`,
    400,
  )
}
