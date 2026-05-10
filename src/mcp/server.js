// The official MCP SDK is the single sanctioned npm dependency.
// It handles JSON-RPC 2.0, schema validation, transport negotiation,
// and protocol compliance.
//
// Doc tools live in mcp/tools/docs.js, asset tools in
// mcp/tools/assets.js, the resource templates in mcp/server/resources.js,
// and shared helpers in mcp/server/helpers.js. This file is the entry
// point + stdio lifecycle.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

import { createCacheRegistry } from './cache.js'
import { registerDocTools } from './tools/docs.js'
import { registerAssetTools } from './tools/assets.js'
import { registerResources } from './server/resources.js'

/**
 * Create an MCP server instance with all tools and resources registered.
 * Separated from startServer() so tests can create a server without stdio.
 *
 * @param {object} ctx - shared command context ({ db, dataDir, logger, ... })
 * @param {object} [deps] - optional injection points
 * @param {object} [deps.cacheRegistry] - pre-built cache registry. HTTP mode
 *   passes one shared registry so cache hits survive across requests; stdio
 *   mode omits it and we create one per process.
 */
export function createServer(ctx, deps = {}) {
  const server = new McpServer(
    { name: 'apple-docs', version: '1.0.0' },
    { capabilities: { resources: {}, tools: {} } },
  )

  const cache = deps.cacheRegistry ?? createCacheRegistry(ctx)

  registerDocTools(server, ctx, cache)
  registerAssetTools(server, ctx, cache)
  registerResources(server, ctx)

  return server
}

/**
 * Start the MCP server, connecting via stdio transport.
 */
export async function startServer(ctx, opts = {}) {
  const { logger } = ctx
  const createServerImpl = opts.createServer ?? createServer
  const createTransport = opts.createTransport ?? (() => new StdioServerTransport())
  const stdin = opts.stdin ?? process.stdin
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  logger.info('MCP server starting (SDK)...')
  const server = createServerImpl(ctx)
  const transport = createTransport()

  let closedResolve = null
  const closed = new Promise(resolve => { closedResolve = resolve })
  let closePromise = null

  const detachListeners = () => {
    stdin.off?.('end', onStdinEnd)
    stdin.off?.('close', onStdinClose)
    stdout.off?.('error', onStdoutError)
    stderr.off?.('error', onStderrError)
  }

  const close = (reason = 'shutdown') => {
    if (closePromise) return closePromise
    detachListeners()
    closePromise = (async () => {
      try {
        if (typeof server.close === 'function') {
          await server.close()
        } else {
          await transport.close?.()
        }
      } catch (error) {
        logger?.warn?.(`MCP server close failed: ${error?.message ?? error}`)
        try {
          await transport.close?.()
        } catch (transportError) {
          logger?.warn?.(`MCP transport close failed: ${transportError?.message ?? transportError}`)
        }
      }
      return reason
    })()
    closePromise.finally(() => { closedResolve?.(reason) })
    return closePromise
  }

  const closeOnPipeEnd = (reason) => {
    logger?.info?.(`MCP stdio disconnected (${reason})`)
    void close(reason)
  }

  const closeOnPipeError = (streamName, error) => {
    if (error?.code === 'EPIPE' || error?.code === 'ERR_STREAM_DESTROYED') {
      closeOnPipeEnd(`${streamName}:${error.code}`)
      return
    }
    logger?.error?.(`MCP ${streamName} stream error: ${error?.message ?? error}`, { stack: error?.stack })
  }

  const onStdinEnd = () => closeOnPipeEnd('stdin:end')
  const onStdinClose = () => closeOnPipeEnd('stdin:close')
  const onStdoutError = (error) => closeOnPipeError('stdout', error)
  const onStderrError = (error) => closeOnPipeError('stderr', error)

  stdin.on?.('end', onStdinEnd)
  stdin.on?.('close', onStdinClose)
  stdout.on?.('error', onStdoutError)
  stderr.on?.('error', onStderrError)

  try {
    await server.connect(transport)
  } catch (error) {
    detachListeners()
    throw error
  }

  return { server, transport, close, closed }
}
