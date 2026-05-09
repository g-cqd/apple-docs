/**
 * HTTP boundary helpers for handlers that previously called
 * `await request.text()` with no size cap and accepted every browser Origin
 * by default. The MCP HTTP server is publicly reachable; both surfaces are
 * trivial DoS / cross-site abuse vectors without these guards.
 *
 * P1.6 (body cap): readBodyCapped + readJsonRpcBodyCapped enforce a hard
 * byte ceiling first via Content-Length, then via a streaming early-abort.
 * P1.7 (origin policy): isLoopbackOrigin lets the MCP server default-deny
 * non-loopback browser origins when no --allow-origin is configured.
 *
 * See docs/plans/phase-3-quality-and-audit-remediation.md.
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

/** Loopback origins always allowed when no explicit --allow-origin policy
 *  is set: http(s)://localhost, http(s)://127.0.0.1, http(s)://[::1] — any
 *  port. Anything else (including non-http schemes) is rejected. */
export function isLoopbackOrigin(origin) {
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}
