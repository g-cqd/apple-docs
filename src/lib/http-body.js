/**
 * Bounded request-body reader for HTTP handlers that previously called
 * `await request.text()` without any size cap. The MCP HTTP server in
 * particular is publicly reachable and was a trivial memory-DoS vector
 * (Bun.serve's default body limit is 128 MiB). See P1.6 in
 * docs/plans/phase-3-quality-and-audit-remediation.md.
 *
 * Two enforcement layers:
 *   1. Cheap: reject up front if `Content-Length` already exceeds the cap.
 *   2. Streaming: for chunked or unknown-length bodies, read the stream and
 *      abort the moment the running total crosses the cap.
 */

/** Hard cap for JSON-RPC POST bodies. Payloads in MCP-style traffic are
 *  O(KB) under normal usage; 1 MiB leaves comfortable headroom for batched
 *  tools/call requests while preventing memory-DoS via 128 MiB defaults. */
export const DEFAULT_MAX_BODY_BYTES = 1_000_000

export class BodyTooLargeError extends Error {
  constructor(maxBytes, observed) {
    super(`request body exceeds ${maxBytes} bytes (observed ${observed})`)
    this.name = 'BodyTooLargeError'
    this.maxBytes = maxBytes
    this.observed = observed
    this.status = 413
  }
}

/**
 * Read a Request body as a UTF-8 string, refusing to buffer more than
 * `maxBytes`. Throws BodyTooLargeError on overflow.
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
export async function readBodyCapped(request, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('maxBytes must be a positive integer')
  }

  const lengthHeader = request.headers.get('content-length')
  if (lengthHeader != null) {
    const declared = Number.parseInt(lengthHeader, 10)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new BodyTooLargeError(maxBytes, declared)
    }
  }

  if (!request.body) return ''

  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* nothing meaningful to do */ }
        throw new BodyTooLargeError(maxBytes, total)
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock?.() } catch { /* nothing meaningful to do */ }
  }

  if (chunks.length === 0) return ''
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0])
  const buf = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    buf.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(buf)
}

/**
 * Read a JSON-RPC POST body with a hard size cap, returning either the body
 * text or a ready-to-return 413 Response with a JSON-RPC error envelope.
 * Centralizes the response shape so MCP HTTP handlers stay terse.
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, body: string } | { ok: false, response: Response }>}
 */
export async function readJsonRpcBodyCapped(request, maxBytes = DEFAULT_MAX_BODY_BYTES) {
  try {
    const body = await readBodyCapped(request, maxBytes)
    return { ok: true, body }
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return {
        ok: false,
        response: Response.json(
          {
            jsonrpc: '2.0',
            error: { code: -32600, message: `request too large (max ${maxBytes} bytes)` },
            id: null,
          },
          { status: 413 },
        ),
      }
    }
    throw err
  }
}
