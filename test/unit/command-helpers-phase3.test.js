import { describe, expect, test } from 'bun:test'
import { discoverAdaptersInParallel } from '../../src/commands/command-helpers.js'

function createAdapter(type, events, discoveryPromise) {
  return {
    constructor: { type },
    async discover() {
      events.push(`discover-${type}-start`)
      const result = await discoveryPromise
      events.push(`discover-${type}-done`)
      return result
    },
  }
}

describe('discoverAdaptersInParallel', () => {
  test('starts discovery for all adapters before awaiting completion', async () => {
    let resolveA
    let resolveB
    const discoveryA = new Promise((resolve) => {
      resolveA = resolve
    })
    const discoveryB = new Promise((resolve) => {
      resolveB = resolve
    })
    const events = []
    const adapters = [
      createAdapter('source-a', events, discoveryA),
      createAdapter('source-b', events, discoveryB),
    ]

    const runPromise = discoverAdaptersInParallel(adapters, {})

    await Promise.resolve()
    expect(events).toEqual(['discover-source-a-start', 'discover-source-b-start'])

    resolveB({ roots: [{ slug: 'root-b' }] })
    resolveA({ roots: [{ slug: 'root-a' }] })

    const { discoveries, errors } = await runPromise
    expect(events).toEqual([
      'discover-source-a-start',
      'discover-source-b-start',
      'discover-source-b-done',
      'discover-source-a-done',
    ])
    expect(errors.size).toBe(0)
    expect(discoveries.get('source-a')).toEqual({ roots: [{ slug: 'root-a' }] })
    expect(discoveries.get('source-b')).toEqual({ roots: [{ slug: 'root-b' }] })
  })

  test('captures discovery failures without aborting sibling adapters', async () => {
    const events = []
    const adapters = [
      {
        constructor: { type: 'source-a' },
        async discover() {
          events.push('discover-source-a-start')
          throw new Error('boom')
        },
      },
      {
        constructor: { type: 'source-b' },
        async discover() {
          events.push('discover-source-b-start')
          return { roots: [{ slug: 'root-b' }] }
        },
      },
    ]

    const { discoveries, errors } = await discoverAdaptersInParallel(adapters, {})

    expect(events).toEqual(['discover-source-a-start', 'discover-source-b-start'])
    expect(discoveries.get('source-b')).toEqual({ roots: [{ slug: 'root-b' }] })
    expect(errors.get('source-a')).toBeInstanceOf(Error)
    expect(errors.get('source-a').message).toBe('boom')
  })
})
