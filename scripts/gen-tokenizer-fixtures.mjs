/**
 * Generate test/fixtures/tokenizer-parity/ — the committed self-regression
 * corpus for the Swift tokenizer.
 *
 * REFERENCE FLIPPED at embedding v2 (RFC 0001 §10, RFC 0002 §6h): the ids
 * are recorded from the Swift implementation itself (swift/Sources/ADEmbed
 * via the ad-embed-dump tool), not from transformers.js. transformers.js
 * 4.2.0 is still replayed as the DIVERGENCE RECORDER: every case where
 * Swift deliberately differs is listed in meta.divergences and validated
 * against EXPECTED_DIVERGENT_CASES below — a Swift regression cannot
 * silently license itself as a new divergence.
 *
 * Emits:
 *   models/<hfId>/{tokenizer.json,tokenizer_config.json} — sha-pinned copies
 *   vocab.json — id-ordered token array (Swift parses an array, never a JSON
 *     object: Swift Dictionary<String,_> conflates canonically-equivalent
 *     keys, and the vocab carries 18 NFD-form Korean entries)
 *   cases.json — { meta, cases: [{ name, text, ids }] }
 *
 * Requires the real pinned model on disk plus the Swift toolchain (dev
 * machine); never fetches. Deterministic: running twice yields
 * byte-identical output. Invisible/ambiguous characters are written as \u
 * escapes so the corpus is reviewable.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from '../src/lib/hash.js'
import { resolveActiveSpec } from '../src/search/embedder.js'
import { PINNED_MODEL_FILES, verifyPinnedModelFiles } from '../src/search/model-integrity.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'test', 'fixtures', 'tokenizer-parity')

// The hand-written divergence contract: exactly these cases must differ from
// the transformers.js replay, all via astral-CJK spacing (the v2 fix) —
// anything else failing the replay is a Swift regression, not a divergence.
const EXPECTED_DIVERGENT_CASES = [
  'cjk-astral',
  'cjk-astral-latin-glue',
  'cjk-astral-run',
  'cjk-astral-compat',
  'judgment-37', // "…𠮷stack" eval query
  'judgment-38', // "…𠮷json" eval query
  'judgment-39', // "𠀀𠀁 …" eval query
]

const spec = resolveActiveSpec()
if (spec.hfId !== 'minishlab/potion-retrieval-32M') {
  throw new Error(`fixtures target the default model; unset APPLE_DOCS_EMBED_MODEL (got ${spec.hfId})`)
}

const modelsDir =
  process.env.APPLE_DOCS_MODELS_DIR ??
  join(process.env.APPLE_DOCS_HOME ?? join(homedir(), '.apple-docs'), 'resources', 'models')

// Fail closed on upstream drift before deriving anything from the files.
await verifyPinnedModelFiles(modelsDir, spec.hfId)

// --- case corpus -------------------------------------------------------------

const synthesized = [
  // Greek Final_Sigma (JS toLowerCase applies it; Swift lowercased() does not)
  ['greek-odos', 'ΟΔΟΣ'],
  ['greek-sigma-words', 'ΣΟΦΟΣ ΣΑΣ ΣΟΦΗΣ'],
  ['greek-sigma-solo', 'Σ'],
  ['greek-sigma-punct', "ΟΔΟΣ. ΟΔΟΣ' (ΟΔΟΣ)"],
  ['greek-sigma-marks', '\u0391\u{3a3}\u{301}\u0391 \u0391\u{3a3}\u{301}'],
  ['greek-mixed', 'Ὀδυσσεύς ΛΌΓΟΣ λόγος'],
  // Case-mapping specials
  ['turkish-dotted-i', 'İstanbul İ I ı i'],
  ['sharp-s', 'STRASSE Straße ẞ ß'],
  ['micro-sign', 'µm µμ Μμ'],
  ['titlecase-digraph', 'ǅungla ǄUNGLA ǆ'],
  // Accents / NFD / mark categories (NFC and decomposed variants spelled out)
  ['accents-nfc-nfd', 'caf\u{e9} cafe\u{301} na\u{ef}ve nai\u{308}ve r\u{e9}sum\u{e9}'],
  ['angstrom', '\u{212b} \u{c5} A\u{30a} 10\u{212b}'],
  ['hebrew-niqqud', 'שָׁלוֹם עִבְרִית'],
  ['arabic-diacritics', 'مُحَمَّد العَرَبِيَّة'],
  ['devanagari', 'हिन्दी कृपया क्षत्रिय'],
  ['thai', 'ภาษาไทย กรุงเทพมหานคร'],
  ['vietnamese', 'Tiếng Việt Hà Nội phở'],
  ['multi-marks-order', 'q\u{301}\u{316} q\u{316}\u{301} a\u{327}\u{301}'],
  ['ligatures', 'ﬁle ﬂow ﬃ'],
  ['combining-enclosing', 'a\u{20dd} b\u{20e3}'],
  // CJK (chinese-char spacing is BMP-only in transformers.js)
  ['cjk-han', '中文分词测试 漢字'],
  ['cjk-mixed-latin', 'Swift中文API设计'],
  ['cjk-astral', '\u{20000}\u{20001} 中\u{20bb7}文'],
  ['cjk-compat', '豈 更 切'],
  ['kana', 'ひらがな カタカナ・テスト'],
  ['hangul', '한국어 형태소 분석'],
  ['hangul-jamo-direct', '\u{1112}\u{1161}\u{11ab}'],
  // Emoji (ZWJ is Cf → removed; VS16 is Mn → stripped; modifiers are Sk → kept)
  ['emoji-basic', 'Hello 👋 world 🌍!'],
  ['emoji-zwj', '\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}\u{200d}\u{1f466} family \u{1f3f3}\u{fe0f}\u{200d}\u{1f308}'],
  ['emoji-skin-tone', '👍🏽 🙏🏿'],
  ['emoji-flags', '🇫🇷 🇺🇸 flags'],
  ['emoji-keycap', '1\u{fe0f}\u{20e3} #\u{20e3}'],
  // Whitespace / control zoo (VT/FF/FEFF/ZWSP/SHY/ZWJ are removed, not spaced)
  ['ws-zs', 'a\u{a0}b\u{2003}c\u{3000}d\u{2028}e\u{2029}f'],
  ['ws-removed-controls', 'a\u{b}b\u{c}c\u{feff}d\u{200b}e\u{ad}f\u{200d}g'],
  ['ws-kept', 'a\tb\nc\rd e'],
  ['control-c0', 'a\u{1}b\u{7}c\u{1f}d'],
  ['nul-fffd', 'a\u{0}b\u{fffd}c'],
  ['soft-hyphen-word', 'hy\u{ad}phen\u{ad}ation'],
  ['ws-only', '   '],
  ['ws-only-mixed', '\t\n\u{a0}\u{3000}'],
  ['empty', ''],
  ['single-space', ' '],
  // Added-token literals (DictionarySplitter, leftmost-longest, pre-normalizer)
  ['special-cls', '[CLS]'],
  ['special-inline', 'x[SEP]y'],
  ['special-adjacent', '[MASK][MASK]'],
  ['special-partial', '[CLS'],
  ['special-lowercase', '[cls]'],
  ['special-nested', '[[SEP]]'],
  ['special-spaced', ' [PAD] padded [UNK] '],
  ['special-inside-word', 'pre[MASK]post'],
  // Punctuation classes (\p{P} + ASCII symbol ranges; €/∑ are NOT punct)
  ['punct-ascii', 'a+b=c <T> x|y ~z ^2 $5 a_b `code`'],
  ['punct-unicode', '«guillemets» — em-dash … ¿qué? ¡sí! ‽'],
  ['punct-currency', '€100 £50 ¥1000 ₹99'],
  ['punct-underscore', 'snake_case_name __init__'],
  ['math-symbols', 'ℕ ℝ ∑ ∂ ≠ ≤ ½ ² ① Ⓐ'],
  // WordPiece edges (code-point counting, ## prefix, whole-word UNK)
  ['word-99', 'a'.repeat(99)],
  ['word-100', 'b'.repeat(100)],
  ['word-101', 'c'.repeat(101)],
  ['word-101-astral', '\u{1d49c}'.repeat(101)],
  ['word-100-astral-mixed', '\u{1d49c}'.repeat(50) + 'x'.repeat(50)],
  ['hash-prefix', '##test ## ###x c## #selector'],
  ['subwords', 'tokenization pretokenizers unbelievable counterintuitive'],
  // Code-flavored text
  ['code-swift-generic', 'func map<T: Hashable>(_ transform: (Element) -> T) -> [T] { fatalError() }'],
  ['code-swift-attrs', '@MainActor final class ViewModel: ObservableObject { @Published var items: [Item] = [] }'],
  ['code-url', 'https://developer.apple.com/documentation/swiftui/view?language=swift#overview'],
  ['code-email-version', 'support@example.com iOS 26.1.2 v3.14'],
  ['code-raw-string', '#"raw \\(string)"# and ##"double"##'],
  // Kitchen sink
  [
    'mixed-paragraph',
    'The Σ-algebra of 测试 cases: café \u{2615}\u{fe0f} at 36.5°C — `body` 屬性 returns [CLS]-free 한국어 text… (naïve‽) £3.50',
  ],
  // Embedding v2 (RFC 0002 §6h): astral CJK is spaced since the v2
  // divergence — these pin the neighbor-recovery behavior (v1 glued
  // see𠮷docs into one whole-word UNK, swallowing the Latin signal).
  ['cjk-astral-latin-glue', 'see\u{20bb7}docs and the \u{20bb7}stack'],
  ['cjk-astral-run', '\u{20000}\u{20001}\u{20002}'],
  ['cjk-astral-compat', '\u{2f800}郎 and\u{2f800}then'],
]

/** Deterministically harvest prose strings from a committed doc fixture. */
function docExcerpts() {
  const doc = JSON.parse(readFileSync(join(ROOT, 'test', 'fixtures', 'swiftui-view.json'), 'utf8'))
  const seen = new Set()
  const out = []
  const walk = (node) => {
    if (out.length >= 30) return
    if (typeof node === 'string') {
      const prose = node.length >= 80 && !node.startsWith('doc://') && (node.match(/ /g)?.length ?? 0) >= 10
      if (prose && !seen.has(node)) {
        seen.add(node)
        out.push(node.slice(0, 1500))
      }
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item)
    } else if (node && typeof node === 'object') {
      for (const value of Object.values(node)) walk(value)
    }
  }
  walk(doc)
  return out
}

const searchQueries = JSON.parse(readFileSync(join(ROOT, 'test', 'golden', 'search-queries.json'), 'utf8'))
const judgments = JSON.parse(readFileSync(join(ROOT, 'test', 'golden', 'eval-judgments.json'), 'utf8')).judgments

const excerpts = docExcerpts()
const longDocs = [0, 10, 20].map((start) => excerpts.slice(start, start + 10).join(' '))

const cases = [
  ...synthesized.map(([name, text]) => ({ name, text })),
  ...searchQueries.map((q) => ({ name: `query-${q.name}`, text: q.query })),
  ...judgments.map((j, i) => ({ name: `judgment-${i}`, text: j.query })),
  ...excerpts.map((text, i) => ({ name: `doc-excerpt-${i}`, text })),
  ...longDocs.map((text, i) => ({ name: `doc-long-${i}`, text })),
]
const duplicateNames = cases.length - new Set(cases.map((c) => c.name)).size
if (duplicateNames > 0) throw new Error(`${duplicateNames} duplicate case names`)

// --- vocab as id-ordered array + pinned model copies (the dump tool reads
// --- these from OUT_DIR, so they are written before tokenization) ------------

const tokenizerJsonPath = join(modelsDir, spec.hfId, 'tokenizer.json')
const vocabObj = JSON.parse(readFileSync(tokenizerJsonPath, 'utf8')).model.vocab
const entries = Object.entries(vocabObj)
const vocab = new Array(entries.length)
for (const [token, id] of entries) {
  if (!Number.isInteger(id) || id < 0 || id >= vocab.length || vocab[id] !== undefined) {
    throw new Error(`vocab ids are not contiguous/unique at ${id}`)
  }
  vocab[id] = token
}
const byteDistinct = new Set(vocab.map((t) => Buffer.from(t, 'utf8').toString('hex')))
if (byteDistinct.size !== vocab.length) throw new Error('vocab tokens are not byte-distinct')

const modelOut = join(OUT_DIR, 'models', spec.hfId)
mkdirSync(modelOut, { recursive: true })
for (const rel of ['tokenizer.json', 'tokenizer_config.json']) {
  const dest = join(modelOut, rel)
  copyFileSync(join(modelsDir, spec.hfId, rel), dest)
  const want = PINNED_MODEL_FILES[spec.hfId][rel]
  const got = await sha256File(dest)
  if (got !== want) throw new Error(`${rel} copy drifted from pin: ${got} != ${want}`)
}
writeFileSync(join(OUT_DIR, 'vocab.json'), JSON.stringify(vocab, null, 1))

// --- tokenize: the Swift implementation is the reference -----------------------

const build = Bun.spawnSync(
  ['swift', 'build', '--package-path', join(ROOT, 'swift'), '-c', 'release', '--product', 'ad-embed-dump'],
  { stdout: 'inherit', stderr: 'inherit' },
)
if (build.exitCode !== 0) throw new Error('swift build of ad-embed-dump failed')
const dump = Bun.spawnSync(
  [join(ROOT, 'swift', '.build', 'release', 'ad-embed-dump'), OUT_DIR],
  { stdin: Buffer.from(JSON.stringify(cases.map((c) => c.text))), stderr: 'inherit' },
)
if (dump.exitCode !== 0) throw new Error('ad-embed-dump failed')
const { behaviorVersion, ids: swiftIds } = JSON.parse(dump.stdout.toString())
for (const [i, ids] of swiftIds.entries()) cases[i].ids = ids

// --- divergence record: replay transformers.js and validate the contract ------

const { AutoTokenizer, env } = await import('@huggingface/transformers')
env.localModelPath = modelsDir
env.cacheDir = modelsDir
env.allowLocalModels = true
env.allowRemoteModels = false
const txTokenizer = await AutoTokenizer.from_pretrained(spec.hfId)
const enc = await txTokenizer(
  cases.map((c) => c.text),
  { add_special_tokens: false, return_tensor: false },
)
const divergences = cases
  .filter((c, i) => JSON.stringify(enc.input_ids[i]) !== JSON.stringify(c.ids))
  .map((c) => c.name)
const unexpected = divergences.filter((n) => !EXPECTED_DIVERGENT_CASES.includes(n))
const missing = EXPECTED_DIVERGENT_CASES.filter((n) => !divergences.includes(n))
if (unexpected.length > 0 || missing.length > 0) {
  throw new Error(
    `divergence contract violated — unexpected: [${unexpected.join(', ')}], expected-but-absent: [${missing.join(', ')}]. ` +
      'A new deliberate divergence needs EXPECTED_DIVERGENT_CASES updated WITH its RFC record; anything else is a Swift regression.',
  )
}

// --- write ---------------------------------------------------------------------

const meta = {
  model: spec.hfId,
  reference: 'swift-ADEmbed',
  behaviorVersion,
  transformersVersion: JSON.parse(
    readFileSync(join(ROOT, 'node_modules', '@huggingface', 'transformers', 'package.json'), 'utf8'),
  ).version,
  tokenizerSha256: PINNED_MODEL_FILES[spec.hfId]['tokenizer.json'],
  divergences,
}

writeFileSync(join(OUT_DIR, 'cases.json'), JSON.stringify({ meta, cases }, null, 1))

console.log(`wrote ${OUT_DIR}`)
console.log(`  cases: ${cases.length} (${synthesized.length} synthesized)`)
console.log(`  vocab: ${vocab.length} tokens`)
console.log(`  total ids: ${cases.reduce((n, c) => n + c.ids.length, 0)}`)
console.log(`  behavior v${behaviorVersion}; divergences from transformers.js: ${divergences.join(', ') || 'none'}`)
