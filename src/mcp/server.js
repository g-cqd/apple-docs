import { TOOL_DEFINITIONS, dispatchTool } from './tools.js'

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'apple-docs', version: '1.0.0' }

/**
 * Start the MCP server, reading JSON-RPC from stdin and writing to stdout.
 */
export async function startServer(ctx) {
  const { logger } = ctx

  logger.info('MCP server starting...')

  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })

    let newlineIdx
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)

      if (!line) continue

      try {
        const msg = JSON.parse(line)
        await handleMessage(msg, ctx)
      } catch (e) {
        logger.error('Failed to parse message', { error: e.message, line: line.slice(0, 200) })
        // Send parse error for requests (not notifications)
        respond(null, null, { code: -32700, message: 'Parse error' })
      }
    }
  }

  logger.info('MCP server stdin closed')
}

async function handleMessage(msg, ctx) {
  const { logger } = ctx

  // Notifications have no id — don't respond
  if (msg.id === undefined || msg.id === null) {
    // Handle known notifications silently
    if (msg.method === 'notifications/initialized') {
      logger.debug('Client initialized')
    }
    return
  }

  const { id, method, params } = msg

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })
      break

    case 'tools/list':
      respond(id, {
        tools: TOOL_DEFINITIONS,
      })
      break

    case 'tools/call': {
      const toolName = params?.name
      const args = params?.arguments ?? {}

      try {
        const result = await dispatchTool(toolName, args, ctx)
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2)
        respond(id, {
          content: [{ type: 'text', text }],
          isError: false,
        })
      } catch (e) {
        logger.error(`Tool error: ${toolName}`, { error: e.message })
        respond(id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        })
      }
      break
    }

    default:
      respond(id, null, { code: -32601, message: `Method not found: ${method}` })
  }
}

function respond(id, result, error) {
  const msg = { jsonrpc: '2.0', id }
  if (error) {
    msg.error = error
  } else {
    msg.result = result
  }
  process.stdout.write(JSON.stringify(msg) + '\n')
}
