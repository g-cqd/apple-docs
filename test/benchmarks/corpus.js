import { DocsDatabase } from '../../src/storage/database.js'

/**
 * Synthetic search corpus for benchmarks. The old 10-document fixture made
 * every search measurement a JS-orchestration microbenchmark: none of the
 * FTS tiers (title, trigram, fuzzy, body) had enough rows to cost anything,
 * so the regression gate was blind to every real search-path change.
 *
 * Shape: `docCount` documents across a handful of framework roots, with
 * realistic multi-word Apple-style titles (shared common words so trigram
 * posting lists get fat), abstracts, declarations, and — for the first
 * `bodyCount` docs — body FTS entries large enough to exercise bm25.
 */
const FRAMEWORKS = ['swiftui', 'uikit', 'foundation', 'combine', 'metal']
const NOUNS = [
  'View', 'Text', 'Button', 'List', 'Navigation', 'Scroll', 'Stack', 'Image',
  'Gesture', 'Animation', 'Binding', 'State', 'Environment', 'Observable',
  'Publisher', 'Subscriber', 'Layer', 'Buffer', 'Texture', 'Pipeline',
]
const VERBS = [
  'Creating', 'Configuring', 'Presenting', 'Animating', 'Observing',
  'Rendering', 'Composing', 'Migrating', 'Handling', 'Updating',
]

export function seedSearchCorpus(db = new DocsDatabase(':memory:'), { docCount = 20000, bodyCount = 5000 } = {}) {
  for (const fw of FRAMEWORKS) {
    db.upsertRoot(fw, fw[0].toUpperCase() + fw.slice(1), 'framework', 'bench')
  }

  db.db.run('BEGIN')
  for (let i = 0; i < docCount; i++) {
    const fw = FRAMEWORKS[i % FRAMEWORKS.length]
    const noun = NOUNS[i % NOUNS.length]
    const verb = VERBS[(i / NOUNS.length | 0) % VERBS.length]
    const isArticle = i % 4 === 0
    const title = isArticle
      ? `${verb} a ${noun.toLowerCase()} in ${fw}`
      : `${noun}${i % 97 === 0 ? '' : String(i % 97)}`
    const key = `${fw}/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${i}`
    db.upsertNormalizedDocument({
      document: {
        sourceType: 'apple-docc',
        key,
        title,
        kind: isArticle ? 'article' : 'symbol',
        role: isArticle ? 'article' : 'symbol',
        roleHeading: isArticle ? 'Article' : 'Structure',
        framework: fw,
        abstractText: `${verb} content with ${noun} across the ${fw} framework for benchmark document ${i}.`,
        declarationText: isArticle ? null : `struct ${noun}${i % 97} : ${noun}Protocol`,
      },
      sections: [],
      relationships: [],
    })
  }
  db.db.run('COMMIT')

  // Body FTS for a subset — enough rows that the deep tier's bm25 MATCH has
  // real work, without making seeding dominate benchmark startup.
  const ids = db.db.query('SELECT id, key, title FROM documents ORDER BY id LIMIT ?').all(bodyCount)
  db.db.run('BEGIN')
  for (const row of ids) {
    const words = `${row.title} ${row.key.replaceAll('/', ' ')}`
    db.insertBody(row.id, `${words}. ${'The framework provides declarative interfaces and composable behavior. '.repeat(20)}${words}.`)
  }
  db.db.run('COMMIT')

  return db
}
