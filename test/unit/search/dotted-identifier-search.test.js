import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'
import { search } from '../../../src/commands/search.js'

// Regression for the reported miss: Apple stores enum-case titles bare /
// concatenated (`AVAudioSessionRouteSelectionExternal`), but users type the
// dotted `Parent.Case` form. Before the fix this returned zero results.
let db
let ctx

beforeAll(() => {
  db = new DocsDatabase(':memory:')
  ctx = {
    db,
    dataDir: '/tmp/apple-docs-dotted-test',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  }
  const root = db.upsertRoot('avfaudio', 'AVFAudio', 'framework', 'test')
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/avfaudio/avaudiosessionrouteselectionexternal',
    url: 'u',
    title: 'AVAudioSessionRouteSelectionExternal',
    role: 'symbol',
    roleHeading: 'Case',
    abstract: 'An externally chosen audio route selection.',
  })
  // Distractor that shares a prefix but must NOT be the match.
  db.upsertPage({
    rootId: root.id,
    path: 'documentation/avfaudio/avaudiosession',
    url: 'u',
    title: 'AVAudioSession',
    role: 'symbol',
  })
})

afterAll(() => {
  db.close()
})

describe('dotted / qualified identifier search', () => {
  const TARGET = 'documentation/avfaudio/avaudiosessionrouteselectionexternal'

  test('a dotted Parent.Case query finds the concatenated-title symbol', async () => {
    const res = await search(
      { query: 'AVAudioSessionRouteSelection.AVAudioSessionRouteSelectionExternal', noDeep: true },
      ctx,
    )
    expect(res.results.map(r => r.path)).toContain(TARGET)
  })

  test('the bare concatenated query ranks the symbol first (tier-0 exact title)', async () => {
    const res = await search({ query: 'AVAudioSessionRouteSelectionExternal', noDeep: true }, ctx)
    expect(res.results[0].path).toBe(TARGET)
  })

  test('a partial dotted query does not throw and returns a result set', async () => {
    const res = await search({ query: 'AVAudioSession.RouteSelection', noDeep: true }, ctx)
    expect(Array.isArray(res.results)).toBe(true)
  })
})
