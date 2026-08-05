import { describe, test, expect } from 'bun:test'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createWordPieceTokenizer, extractEmbeddingMatrix, loadStaticModel2Vec, quantizeMatrixQ8, parseQ8Matrix } from '../../../src/search/model2vec-static.js'

// ---------------------------------------------------------------------------
// Tokenizer — synthetic vocab exercising the Bert pipeline end to end.
// ---------------------------------------------------------------------------

function makeTokenizerJson(vocabWords, overrides = {}) {
  const vocab = {}
  let id = 0
  for (const w of ['[PAD]', '[UNK]', ...vocabWords]) vocab[w] = id++
  return {
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: true },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab },
    ...overrides,
  }
}

describe('createWordPieceTokenizer', () => {
  const tok = createWordPieceTokenizer(makeTokenizerJson([
    'swift', 'ui', '##ui', 'navigation', 'stack', '.', ',', 'cafe', '中', '文', 'a', '##b', '##c',
  ]))
  const ids = (text) => tok.encode(text)
  const vocabId = (piece) => {
    const t = makeTokenizerJson(['swift', 'ui', '##ui', 'navigation', 'stack', '.', ',', 'cafe', '中', '文', 'a', '##b', '##c'])
    return t.model.vocab[piece]
  }

  test('lowercases and splits on whitespace', () => {
    expect(ids('Swift NAVIGATION stack')).toEqual([vocabId('swift'), vocabId('navigation'), vocabId('stack')])
  })

  test('greedy longest-match with ## continuation', () => {
    expect(ids('swiftui')).toEqual([vocabId('swift'), vocabId('##ui')])
    expect(ids('abc')).toEqual([vocabId('a'), vocabId('##b'), vocabId('##c')])
  })

  test('punctuation splits into standalone tokens', () => {
    expect(ids('swift.ui')).toEqual([vocabId('swift'), vocabId('.'), vocabId('ui')])
    expect(ids('swift,')).toEqual([vocabId('swift'), vocabId(',')])
  })

  test('unknown words and unmatchable pieces map to [UNK]', () => {
    expect(ids('zzz')).toEqual([1])
    expect(ids('swiftzzz')).toEqual([1]) // any gap → whole word UNK
  })

  test('strip_accents follows lowercase default', () => {
    expect(ids('Café')).toEqual([vocabId('cafe')])
  })

  test('CJK chars tokenize individually', () => {
    expect(ids('中文')).toEqual([vocabId('中'), vocabId('文')])
  })

  test('empty and whitespace-only input produce no tokens', () => {
    expect(ids('')).toEqual([])
    expect(ids('   \t\n')).toEqual([])
  })

  test('words beyond max_input_chars_per_word collapse to [UNK]', () => {
    expect(ids('x'.repeat(101))).toEqual([1])
  })

  test('rejects non-WordPiece tokenizer configs loudly', () => {
    expect(() => createWordPieceTokenizer({ model: { type: 'Unigram' } })).toThrow(/unsupported tokenizer model/)
    expect(() => createWordPieceTokenizer(makeTokenizerJson([], { normalizer: { type: 'NFKC' } }))).toThrow(/unsupported normalizer/)
  })
})

// ---------------------------------------------------------------------------
// ONNX initializer extraction — hand-encoded minimal TensorProto.
// ---------------------------------------------------------------------------

function varint(n) {
  const out = []
  let v = BigInt(n)
  do {
    let b = Number(v & 0x7fn)
    v >>= 7n
    if (v > 0n) b |= 0x80
    out.push(b)
  } while (v > 0n)
  return out
}

function lenDelimited(fieldNum, payload) {
  return [...varint((fieldNum << 3) | 2), ...varint(payload.length), ...payload]
}

function varintField(fieldNum, value) {
  return [...varint(fieldNum << 3), ...varint(value)]
}

describe('extractEmbeddingMatrix', () => {
  test('finds a 2-D fp32 initializer inside model/graph', () => {
    const rows = 3
    const cols = 2
    const data = new Float32Array([1, 2, 3, 4, 5, 6])
    const raw = new Uint8Array(data.buffer)
    const tensor = [
      ...varintField(1, rows), ...varintField(1, cols), // dims
      ...varintField(2, 1), // data_type FLOAT
      ...lenDelimited(8, [...new TextEncoder().encode('embedding_bag.weight')]),
      ...lenDelimited(9, [...raw]),
    ]
    const graph = lenDelimited(5, tensor)
    const model = new Uint8Array(lenDelimited(7, graph))
    const out = extractEmbeddingMatrix(model)
    expect(out.rows).toBe(rows)
    expect(out.dims).toBe(cols)
    expect(Array.from(out.data)).toEqual([1, 2, 3, 4, 5, 6])
  })

  test('throws when no matching initializer exists', () => {
    const model = new Uint8Array(lenDelimited(7, lenDelimited(5, varintField(2, 1))))
    expect(() => extractEmbeddingMatrix(model)).toThrow(/no 2-D fp32 embedding initializer/)
  })
})

// ---------------------------------------------------------------------------
// int8 matrix codec
// ---------------------------------------------------------------------------

describe('quantizeMatrixQ8 / parseQ8Matrix', () => {
  test('roundtrips within per-row quantization resolution', () => {
    const rows = 7
    const dims = 5
    const data = new Float32Array(rows * dims)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 1.37) * (1 + (i % 3))
    const bytes = quantizeMatrixQ8({ rows, dims, data })
    const back = parseQ8Matrix(bytes)
    expect(back.rows).toBe(rows)
    expect(back.dims).toBe(dims)
    for (let r = 0; r < rows; r++) {
      let maxAbs = 0
      for (let d = 0; d < dims; d++) maxAbs = Math.max(maxAbs, Math.abs(data[r * dims + d]))
      const tolerance = (maxAbs / 127) / 2 + 1e-7 // half a quantization step
      for (let d = 0; d < dims; d++) {
        expect(Math.abs(back.data[r * dims + d] - data[r * dims + d])).toBeLessThanOrEqual(tolerance)
      }
    }
  })

  test('is deterministic (byte-identical across runs)', () => {
    const data = new Float32Array([0.1, -0.2, 0.3, -0.4, 0.5, -0.6])
    const a = quantizeMatrixQ8({ rows: 2, dims: 3, data })
    const b = quantizeMatrixQ8({ rows: 2, dims: 3, data })
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true)
  })

  test('all-zero rows survive (scale falls back to 1)', () => {
    const back = parseQ8Matrix(quantizeMatrixQ8({ rows: 1, dims: 4, data: new Float32Array(4) }))
    expect(Array.from(back.data)).toEqual([0, 0, 0, 0])
  })

  test('rejects corrupt headers and truncated payloads', () => {
    const good = quantizeMatrixQ8({ rows: 2, dims: 2, data: new Float32Array([1, 2, 3, 4]) })
    expect(() => parseQ8Matrix(good.subarray(0, good.length - 1))).toThrow(/truncated/)
    const bad = good.slice()
    bad[0] = 0x58
    expect(() => parseQ8Matrix(bad)).toThrow(/bad magic/)
  })
})

// ---------------------------------------------------------------------------
// Full-model smoke — only when a real installed model is on disk (dev boxes;
// CI without the model skips). Guards tokenizer/pooling drift against the
// shipped artifact.
// ---------------------------------------------------------------------------

const realModelDir = join(homedir(), '.apple-docs', 'resources', 'models', 'minishlab', 'potion-retrieval-32M')

describe.skipIf(!existsSync(join(realModelDir, 'onnx', 'model.onnx')))('loadStaticModel2Vec (installed model)', () => {
  test('embeds unit-norm 512-d vectors and ranks related text closer', async () => {
    const embedder = await loadStaticModel2Vec({ modelDir: realModelDir })
    const [q, related, unrelated] = await embedder.embedBatch([
      'navigation stack in SwiftUI',
      'NavigationStack manages a stack of views for navigation',
      'baking sourdough bread with a dutch oven',
    ])
    expect(q.length).toBe(512)
    const norm = Math.hypot(...q)
    expect(Math.abs(norm - 1)).toBeLessThan(1e-5)
    const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
    expect(dot(q, related)).toBeGreaterThan(dot(q, unrelated))
  })

  test('empty input embeds via token id 0 (EmbeddingBag parity)', async () => {
    const embedder = await loadStaticModel2Vec({ modelDir: realModelDir })
    const v = await embedder.embed('')
    expect(v.length).toBe(512)
    expect(Number.isFinite(v[0])).toBe(true)
  })
})
