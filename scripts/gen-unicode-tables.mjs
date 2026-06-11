/**
 * Generate swift/Sources/ADEmbed/GeneratedUnicodeTables.swift from THIS
 * JavaScript engine's Unicode behavior (RFC 0002 Phase 1).
 *
 * The Swift tokenizer must reproduce @huggingface/transformers' token ids
 * bit-for-bit, and that library delegates every character-class decision to
 * the host engine (regex `\p{…}`, `\s`, `String.normalize("NFD")`). Deriving
 * the tables from the same engine that generates the parity fixtures
 * (scripts/gen-tokenizer-fixtures.mjs) eliminates Unicode-version skew
 * between Swift's stdlib and JavaScriptCore by construction. Swift stdlib is
 * consulted only for canonical combining classes and Final_Sigma casing
 * properties, which this table set cannot capture.
 *
 * Captured semantics (read from @huggingface/transformers 4.2.0 dist,
 * BertNormalizer/BertPreTokenizer):
 *   - clean_text removal: cp === 0 || cp === 0xFFFD || is_control(char),
 *     where is_control exempts \t \n \r and otherwise tests
 *     /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u
 *   - whitespace → ' ' mapping: /^\s$/
 *   - strip_accents filter: /\p{Mn}/gu
 *   - Bert punctuation: \p{P} plus ASCII ! - / : - @ [ - ` { - ~
 *   - tokenize_chinese_chars iterates UTF-16 UNITS, so the astral CJK ranges
 *     in its source are dead code: only BMP scalars can ever match. The
 *     emitted set mirrors that quirk (astral CJK is intentionally absent).
 *   - NFD: String.normalize("NFD"); Hangul syllables (U+AC00–U+D7A3) are
 *     omitted from the table — Swift decomposes them algorithmically.
 *
 * Deterministic for a given engine; the engine version is recorded in the
 * generated header so regeneration diffs are self-explaining.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'swift', 'Sources', 'ADEmbed', 'GeneratedUnicodeTables.swift')

const MAX_SCALAR = 0x10ffff
const isSurrogate = (cp) => cp >= 0xd800 && cp <= 0xdfff

// --- transformers.js v4.2.0 mirrors -----------------------------------------

const CONTROL_RE = /^\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}$/u
const isControl = (char) => {
  switch (char) {
    case '\t':
    case '\n':
    case '\r':
      return false
    default:
      return CONTROL_RE.test(char)
  }
}

const isRemoved = (cp, char) => cp === 0 || cp === 0xfffd || isControl(char)
const isJsWhitespace = (char) => /^\s$/.test(char)
const isMn = (char) => /^\p{Mn}$/u.test(char)
const isBertPunctuation = (char) =>
  /^[\p{P}!-/:-@[-`{-~]$/u.test(char)

// Ranges as they appear in the library source; astral entries are unreachable
// there because the iteration is per UTF-16 unit.
const isChineseChar = (cp) =>
  (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0x3400 && cp <= 0x4dbf) ||
  (cp >= 0x20000 && cp <= 0x2a6df) ||
  (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) ||
  (cp >= 0x2b820 && cp <= 0x2ceaf) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0x2f800 && cp <= 0x2fa1f)
const isEffectiveChinese = (cp) => cp <= 0xffff && isChineseChar(cp)

// --- scan --------------------------------------------------------------------

const sets = {
  cleanTextRemoval: [],
  jsWhitespace: [],
  nonspacingMark: [],
  bertPunctuation: [],
  chineseChar: [],
}
const nfd = [] // [cp, [scalars...]]

const isHangulSyllable = (cp) => cp >= 0xac00 && cp <= 0xd7a3

for (let cp = 0; cp <= MAX_SCALAR; cp++) {
  if (isSurrogate(cp)) continue
  const char = String.fromCodePoint(cp)
  if (isRemoved(cp, char)) sets.cleanTextRemoval.push(cp)
  if (isJsWhitespace(char)) sets.jsWhitespace.push(cp)
  if (isMn(char)) sets.nonspacingMark.push(cp)
  if (isBertPunctuation(char)) sets.bertPunctuation.push(cp)
  if (isEffectiveChinese(cp)) sets.chineseChar.push(cp)
  if (!isHangulSyllable(cp)) {
    const d = char.normalize('NFD')
    if (d !== char) nfd.push([cp, [...d].map((c) => c.codePointAt(0))])
  }
}

// --- encode ------------------------------------------------------------------

/** Collapse a sorted scalar list into flat inclusive [lo, hi] pairs. */
function toRanges(list) {
  const out = []
  for (const cp of list) {
    if (out.length > 0 && out[out.length - 1] === cp - 1) out[out.length - 1] = cp
    else out.push(cp, cp)
  }
  return out
}

function formatArray(name, values) {
  const lines = []
  for (let i = 0; i < values.length; i += 10) {
    lines.push(
      `    ${values
        .slice(i, i + 10)
        .map((v) => `0x${v.toString(16).toUpperCase()}`)
        .join(', ')},`,
    )
  }
  return `  static let ${name}: [UInt32] = [\n${lines.join('\n')}\n  ]`
}

const nfdIndex = nfd.map(([cp]) => cp)
const nfdOffsets = [0]
const nfdPayload = []
for (const [, scalars] of nfd) {
  nfdPayload.push(...scalars)
  nfdOffsets.push(nfdPayload.length)
}

const stats = Object.entries(sets)
  .map(([name, list]) => `${name}: ${list.length} scalars / ${toRanges(list).length / 2} ranges`)
  .concat(`nfd: ${nfd.length} entries / ${nfdPayload.length} payload scalars`)

const swift = `// Generated by scripts/gen-unicode-tables.mjs — DO NOT EDIT BY HAND.
// Regenerate: bun scripts/gen-unicode-tables.mjs
//
// Engine: Bun ${Bun.version} (JavaScriptCore) — the same engine that produces
// test/fixtures/tokenizer-parity/cases.json, so these tables match the parity
// target's Unicode behavior by construction (see the generator header for the
// captured @huggingface/transformers 4.2.0 semantics).
//
// ${stats.join('\n// ')}

/// Engine-derived character classes and canonical decompositions for the
/// transformers.js-parity tokenizer. Range tables are flat inclusive
/// [lo, hi] pairs sorted ascending; see UnicodeSets.swift for lookups.
enum UnicodeTables {
${formatArray('cleanTextRemoval', toRanges(sets.cleanTextRemoval))}

${formatArray('jsWhitespace', toRanges(sets.jsWhitespace))}

${formatArray('nonspacingMark', toRanges(sets.nonspacingMark))}

${formatArray('bertPunctuation', toRanges(sets.bertPunctuation))}

${formatArray('chineseChar', toRanges(sets.chineseChar))}

  /// Scalars with a non-trivial canonical decomposition (Hangul syllables
  /// excluded — decomposed algorithmically). Fully expanded recursively, in
  /// canonical order, exactly as String.normalize("NFD") returns them.
${formatArray('nfdIndex', nfdIndex)}

  /// nfdOffsets[i]..<nfdOffsets[i+1] bounds nfdIndex[i]'s payload slice.
${formatArray('nfdOffsets', nfdOffsets)}

${formatArray('nfdPayload', nfdPayload)}
}
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, swift)
console.log(`wrote ${OUT}`)
for (const line of stats) console.log(`  ${line}`)
