/**
 * Minimal route registry for the dev server.
 *
 * Two-level matching:
 *   1. Exact pathname → handler (cheap Map lookup).
 *   2. Prefix patterns → handler (small ordered list of regexes).
 *
 * Handlers receive (request, webContext, url, match?). They return a
 * `Response` (or null to defer to the next match). If `dispatch` finds no
 * match it returns null; the caller renders the 404.
 *
 * @typedef {(request: Request, ctx: import('./context.js').WebContext, url: URL, match?: RegExpMatchArray) => Response | Promise<Response> | null | Promise<null>} RouteHandler
 */

/**
 * @returns {{
 *   register: (pathname: string, handler: RouteHandler) => void,
 *   registerPattern: (pattern: RegExp, handler: RouteHandler) => void,
 *   dispatch: (request: Request, ctx: import('./context.js').WebContext) => Promise<Response | null>,
 * }}
 */
export function createRouteRegistry() {
  /** @type {Map<string, RouteHandler>} */
  const exact = new Map()
  /** @type {Array<{ pattern: RegExp, handler: RouteHandler }>} */
  const patterns = []

  return {
    register(pathname, handler) {
      if (exact.has(pathname)) {
        throw new Error(`route-registry: duplicate exact route ${pathname}`)
      }
      exact.set(pathname, handler)
    },
    registerPattern(pattern, handler) {
      patterns.push({ pattern, handler })
    },
    async dispatch(request, ctx) {
      const url = new URL(request.url)
      const exactHandler = exact.get(url.pathname)
      if (exactHandler) {
        const response = await exactHandler(request, ctx, url)
        if (response) return response
      }
      for (const { pattern, handler } of patterns) {
        const match = url.pathname.match(pattern)
        if (match) {
          const response = await handler(request, ctx, url, match)
          if (response) return response
        }
      }
      return null
    },
  }
}
