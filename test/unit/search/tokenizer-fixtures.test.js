/**
 * Guards for the committed tokenizer-parity fixtures (RFC 0002 Phase 1).
 *
 * The Swift tokenizer's 100%-parity gate runs against
 * test/fixtures/tokenizer-parity/cases.json, so the fixtures must stay an
 * exact record of what production tokenization does. This file alarms when
 * either input drifts: the pinned model files (sha against
 * PINNED_MODEL_FILES) or transformers.js itself (full case replay + version
 * stamp). On a transformers bump that changes behavior: regenerate via
 * `bun scripts/gen-tokenizer-fixtures.mjs` and make the Swift suite re-pass.
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

  test('vocab.json is the id-ordered mirror of tokenizer.json', () => {
    const vocab = JSON.parse(readFileSync(join(FIXTURES, 'vocab.json'), 'utf8'))
    const declared = JSON.parse(
      readFileSync(join(FIXTURES, 'models', HF_ID, 'tokenizer.json'), 'utf8'),
    ).model.vocab
    const entries = Object.entries(declared)
    expect(vocab.length).toBe(entries.length)
    for (const [token, id] of entries) {
      if (vocab[id] !== token) {
        throw new Error(`vocab.json[${id}] = ${JSON.stringify(vocab[id])}, tokenizer.json says ${JSON.stringify(token)}`)
      }
    }
  })

  describe.skipIf(!transformers)('transformers.js replay', () => {
    test('installed version matches the fixture stamp', () => {
      expect(transformers.env.version).toBe(meta.transformersVersion)
    })

    test('every case reproduces its recorded ids', async () => {
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
      const mismatches = cases
        .filter((c, i) => JSON.stringify(enc.input_ids[i]) !== JSON.stringify(c.ids))
        .map((c) => c.name)
      expect(mismatches).toEqual([])
    })
  })
})
