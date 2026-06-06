import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DocsDatabase } from '../../../src/storage/database.js'
import { indexEmbeddings } from '../../../src/commands/index-embeddings.js'
import { search } from '../../../src/commands/search.js'
import { topicEmbedder } from '../../helpers/topic-embedder.js'

const DOCS = [
  { key: 'fw/alpha', title: 'Alpha', abstract: 'plays audio buffers' },
  { key: 'fw/beta', title: 'Beta', abstract: 'sends a network request' },
  { key: 'fw/gamma', title: 'Gamma', abstract: 'arranges layout' },
]

function seed(db) {
  const root = db.upsertRoot('fw', 'FW', 'framework', 'test')
  for (const d of DOCS) {
    db.upsertPage({ rootId: root.id, path: d.key, url: 'u', title: d.title, role: 'symbol', abstract: d.abstract })
    db.upsertNormalizedDocument({
      document: { key: d.key, title: d.title, sourceType: 'apple-docc', framework: 'fw', role: 'symbol', abstractText: d.abstract },
      sections: [], relationships: [],
    })
  }
}

let db
let ctx

beforeEach(async () => {
  db = new DocsDatabase(':memory:')
  ctx = { db, dataDir: '/tmp/x', logger: { debug() {}, info() {}, warn() {}, error() {} }, embedder: topicEmbedder() }
  seed(db)
  await indexEmbeddings({ embedder: topicEmbedder() }, ctx)
})

afterEach(() => db.close())

describe('hybrid semantic search', () => {
  test('exact title query keeps its top hit when semantic is active', async () => {
    const r = await search({ query: 'Alpha', noDeep: true }, ctx)
    expect(r.results[0].path).toBe('fw/alpha')
  })

  test('a synonym query surfaces the topical doc via fusion (no lexical overlap)', async () => {
    // "sound" appears in no title/abstract → lexical-only would return nothing;
    // the semantic tier maps sound → audio → Alpha.
    const r = await search({ query: 'sound', noDeep: true }, ctx)
    expect(r.results.map(x => x.path)).toContain('fw/alpha')
  })

  test('dormant (no vectors) → identical to lexical-only', async () => {
    const bare = new DocsDatabase(':memory:')
    seed(bare)
    try {
      const r = await search({ query: 'sound', noDeep: true }, { db: bare, dataDir: '/tmp/x', logger: ctx.logger })
      expect(r.results.length).toBe(0) // no lexical match, no vectors → nothing
    } finally {
      bare.close()
    }
  })
})
