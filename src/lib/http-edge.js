/**
 * Helpers for requests that arrive through the public edge (Cloudflare
 * tunnel → Caddy → Bun).
 *
 * Cloudflare always stamps `CF-Connecting-IP` and `CF-Ray` on proxied
 * requests and overwrites any client-supplied value, so their presence
 * separates public traffic from local traffic (operator probes, the
 * watchdog, the dev server on loopback). The Bun listeners bind to loopback
 * only, so a local process is the only way to forge these headers.
 */

/**
 * True when the request came through the Cloudflare edge.
 *
 * @param {Request} request
 * @returns {boolean}
 */
export function isEdgeRequest(request) {
  const headers = request.headers
  return headers.has('cf-connecting-ip') || headers.has('cf-ray')
}

/**
 * Resolve the client address used as a rate-limit key.
 *
 * Order: `CF-Connecting-IP` (the real visitor behind Cloudflare), the first
 * `X-Forwarded-For` hop, then the socket peer. Caddy rewrites
 * `X-Forwarded-For` to its own peer (loopback) when no trusted proxies are
 * configured, so the Cloudflare header must come first or every visitor
 * would share one bucket.
 *
 * @param {Request} request
 * @param {{ requestIP?: (req: Request) => { address: string } | null }} [server]
 * @returns {string}
 */
export function resolveClientIp(request, server) {
  const cf = request.headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  if (forwarded) return forwarded
  try {
    return server?.requestIP?.(request)?.address ?? 'unknown'
  } catch {
    return 'unknown'
  }
}
