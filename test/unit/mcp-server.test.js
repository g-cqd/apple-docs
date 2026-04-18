import { describe, expect, test } from 'bun:test'
import { startServer } from '../../src/mcp/server.js'

describe('startServer', () => {
  test('connects the provided transport to the MCP server', async () => {
    const events = []
    const fakeTransport = {}
    const fakeServer = {
      async connect(transport) {
        events.push(['connect', transport])
      },
    }

    await startServer(
      {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
      {
        createServer() {
          return fakeServer
        },
        createTransport() {
          return fakeTransport
        },
      },
    )

    expect(events).toEqual([['connect', fakeTransport]])
  })
})
