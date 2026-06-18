/**
 * Guards for the committed tokenizer-parity fixtures.
 *
 * REFERENCE FLIPPED at embedding v2 (RFC 0002 §6h): cases.json records the
 * Swift tokenizer's own output (self-regression goldens, gated by the Swift
 * suite). transformers.js stays on as the DIVERGENCE RECORDER: every case in
 * meta.divergences must DIFFER from the replay (each divergence stays real
 * and deliberate), every other case must still MATCH (an upstream
 * transformers bump that changes anything else still alarms here). On a
 * legitimate change: regenerate via `bun scripts/gen-tokenizer-fixtures.mjs`
 * (which validates divergences against its hand-written expected list) and
 * make the Swift suite re-pass.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PINNED_MODEL_FILES, verifyPinnedModelFiles } from '../../../src/search/model-integrity.js'

const FIXTURES = join(import.meta.dir, '..', '..', 'fixtures', 'tokenizer-parity')
const HF_ID = 'minishlab/potion-retrieval-32M'

// Optional dependency: present in dev/CI installs, absent in minimal ones.
let transformers = null
try {
  transformers = await import('@huggingface/transformers')
} catch {
  // replay suite skips below
}

const { meta, cases } = JSON.parse(readFileSync(join(FIXTURES, 'cases.json'), 'utf8'))

describe('tokenizer-parity fixtures', () => {
  test('committed model files match the production integrity pins', async () => {
    const pins = {
      [HF_ID]: {
        'tokenizer.json': PINNED_MODEL_FILES[HF_ID]['tokenizer.json'],
        'tokenizer_config.json': PINNED_MODEL_FILES[HF_ID]['tokenizer_config.json'],
      },
    }
    const { verified } = await verifyPinnedModelFiles(join(FIXTURES, 'models'), HF_ID, pins)
    expect(verified).toBe(2)
    expect(meta.tokenizerSha256).toBe(PINNED_MODEL_FILES[HF_ID]['tokenizer.json'])
  })

  test('fixtures record the Swift reference and its divergence list', () => {
    expect(meta.reference).toBe('swift-ADEmbed')
    expect(meta.behaviorVersion).toBeGreaterThanOrEqual(2)
    expect(Array.isArray(meta.divergences)).toBe(true)
    expect(meta.divergences.length).toBeGreaterThan(0)
    const names = new Set(cases.map((c) => c.name))
    for (const name of meta.divergences) expect(names.has(name)).toBe(true)
  })

  test('vocab.json is the id-ordered mirror of tokenizer.json', () => {
    const vocab = JSON.parse(readFileSync(join(FIXTURES, 'vocab.json'), 'utf8'))
    const declared = JSON.parse(readFileSync(join(FIXTURES, 'models', HF_ID, 'tokenizer.json'), 'utf8')).model.vocab
    const entries = Object.entries(declared)
    expect(vocab.length).toBe(entries.length)
    for (const [token, id] of entries) {
      if (vocab[id] !== token) {
        throw new Error(`vocab.json[${id}] = ${JSON.stringify(vocab[id])}, tokenizer.json says ${JSON.stringify(token)}`)
      }
    }
  })

  describe.skipIf(!transformers)('transformers.js divergence record', () => {
    test('installed version matches the comparison vintage', () => {
      expect(transformers.env.version).toBe(meta.transformersVersion)
    })

    test('non-divergent cases match the replay; divergent cases differ', async () => {
      const { AutoTokenizer, env } = transformers
      env.localModelPath = join(FIXTURES, 'models')
      env.cacheDir = join(FIXTURES, 'models')
      env.allowLocalModels = true
      env.allowRemoteModels = false
      const tokenizer = await AutoTokenizer.from_pretrained(HF_ID)
      const enc = await tokenizer(
        cases.map((c) => c.text),
        { add_special_tokens: false, return_tensor: false },
      )
      const divergent = new Set(meta.divergences)
      const unexpectedMismatches = []
      const staleDivergences = []
      for (const [i, c] of cases.entries()) {
        const matches = JSON.stringify(enc.input_ids[i]) === JSON.stringify(c.ids)
        if (divergent.has(c.name) && matches) staleDivergences.push(c.name)
        if (!divergent.has(c.name) && !matches) unexpectedMismatches.push(c.name)
      }
      expect(unexpectedMismatches).toEqual([])
      expect(staleDivergences).toEqual([])
    })
  })
})
