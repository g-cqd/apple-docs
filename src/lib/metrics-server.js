/**
 * Optional Prometheus scrape endpoint for the long-running servers
 * (`apple-docs web serve` and `apple-docs mcp serve`).
 *
 * Phase D.2: opt-in only — the metrics server starts only when the operator
 * passes `--metrics-port`. When absent, no listener is created and there is
 * zero per-request overhead on the main server.
 *
 * Bound to 127.0.0.1 by default. Prometheus scrape endpoints are an internal
 * surface — they are not gated by the main server's auth / rate-limit
 * middleware (a scrape burst would flap the rate-limiter and a scraper
 * brings its own auth model). Override the bind host with `--metrics-host`
 * only when the scraper is on a separate node.
 *
 * The provider is a synchronous function returning the metrics array on
 * each call — values are cheap in-memory reads from existing counters, so
 * caching the array itself buys nothing and makes invalidation a worry.
 */

import { formatPrometheus, PROMETHEUS_CONTENT_TYPE } from './metrics.js'

/**
 * @param {object} opts
 * @param {number}        opts.port - listen port (0 picks any free port)
 * @param {string}       [opts.host='127.0.0.1']
 * @param {() => Array}   opts.provider - returns the metrics array per request
 * @param {(cfg: object) => any} [opts.serve] - injected for tests; defaults
 *   to `Bun.serve`
 * @param {{ info?: Function, error?: Function }} [opts.logger]
 * @returns {{ server: any, url: string, port: number,
 *   close: () => Promise<void> }}
 */
export function startMetricsServer(opts) {
  const { provider } = opts
  if (typeof provider !== 'function') {
    throw new Error('startMetricsServer: provider must be a function')
  }
  const host = opts.host ?? '127.0.0.1'
  const requestedPort = opts.port ?? 0
  const serveImpl = opts.serve ?? ((cfg) => Bun.serve(cfg))
  const logger = opts.logger

  const server = serveImpl({
    port: requestedPort,
    hostname: host,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== '/metrics') {
        return new Response('Not Found', { status: 404 })
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        })
      }
      let body
      try {
        body = formatPrometheus(provider())
      } catch (err) {
        logger?.error?.(`metrics-server: provider threw: ${err?.message ?? err}`)
        return new Response('metrics provider error\n', {
          status: 500,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        })
      }
      return new Response(request.method === 'HEAD' ? null : body, {
        status: 200,
        headers: {
          'Content-Type': PROMETHEUS_CONTENT_TYPE,
          'Cache-Control': 'no-store',
        },
      })
    },
  })

  const port = server?.port ?? requestedPort
  const url = `http://${host}:${port}/metrics`
  logger?.info?.(`metrics endpoint listening at ${url}`)

  async function close() {
    try { server?.stop?.(true) } catch {}
  }

  return { server, url, port, close }
}
