import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { disposeHighlighter, getHighlighterState } from '../../src/content/highlight.js'
import { startServer } from '../../src/mcp/server.js'

beforeEach(() => {
  disposeHighlighter()
})

afterEach(() => {
  disposeHighlighter()
})

describe('startServer', () => {
  test('connects without starting syntax highlighter warmup', async () => {
    const events = []
    const fakeTransport = {}
    const fakeServer = {
      async connect(transport) {
        events.push(['connect', transport])
      },
    }

    expect(getHighlighterState()).toEqual({ ready: false, warming: false })

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
        disposeHighlighter() {
          events.push(['dispose'])
        },
      },
    )

    expect(getHighlighterState()).toEqual({ ready: false, warming: false })
    expect(events).toEqual([['connect', fakeTransport]])
    expect(typeof fakeTransport.onclose).toBe('function')

    fakeTransport.onclose()

    expect(events).toEqual([
      ['connect', fakeTransport],
      ['dispose'],
    ])
  })
})
