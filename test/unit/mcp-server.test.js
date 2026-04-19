import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
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

    const handle = await startServer(
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
    expect(handle).toMatchObject({ server: fakeServer, transport: fakeTransport })
  })

  test('closes when stdio disconnects', async () => {
    const events = []
    const stdin = new EventEmitter()
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const fakeTransport = {
      async close() {
        events.push(['transport-close'])
      },
    }
    const fakeServer = {
      async connect(transport) {
        events.push(['connect', transport])
      },
      async close() {
        events.push(['server-close'])
        await fakeTransport.close()
      },
    }

    const handle = await startServer(
      {
        logger: {
          info() {},
          warn() {},
          error() {},
        },
      },
      {
        stdin,
        stdout,
        stderr,
        createServer() {
          return fakeServer
        },
        createTransport() {
          return fakeTransport
        },
      },
    )

    stdin.emit('end')
    await handle.closed

    expect(events).toEqual([
      ['connect', fakeTransport],
      ['server-close'],
      ['transport-close'],
    ])
  })
})
