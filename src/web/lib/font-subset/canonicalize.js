/**
 * Canonicalize a font-subset request into a deterministic shape suitable
 * for SHA-256 cache keying. Both the POST JSON body and the GET query
 * string get fed through this so the local LRU + on-disk cache and the
 * Cloudflare edge cache (which keys on path+query for GETs) all converge
 * on the same cache key.
 *
 * Canonical shape:
 *   { font: string, codepoints: number[], format: 'woff2'|'ttf'|'otf' }
 *
 * `codepoints` is deduplicated, sorted ascending. `format` defaults to
 * `'woff2'`. Empty inputs are rejected.
 *
 * Accepted codepoint encodings (string form, lenient):
 *   - decimal:  `65`
 *   - hex 0x:   `0x41`, `0X41`
 *   - U+ form:  `U+0041`, `u+41`
 *
 * Range form:
 *   - tuple in JSON: `[0x41, 0x5A]` (inclusive)
 *   - string in GET: `U+0041-U+005A`, `0x41-0x5A`, `65-90`
 *
 * Character form:
 *   - JS string; expanded via `[...str]` so surrogate pairs (emoji) yield
 *     a single supplementary-plane codepoint.
 */

const ALLOWED_FORMATS = Object.freeze(['woff2', 'ttf', 'otf'])
export const DEFAULT_FORMAT = 'woff2'
export const MAX_CODEPOINTS_PER_REQUEST = 10_000
const UNICODE_MAX = 0x10ffff

export class CanonicalizeError extends Error {
  constructor(message, { status = 400, details } = {}) {
    super(message)
    this.name = 'CanonicalizeError'
    this.status = status
    if (details !== undefined) this.details = details
  }
}

/**
 * Canonicalize a parsed POST body shape.
 * @param {object} body
 * @returns {{ font: string, codepoints: number[], format: string }}
 */
export function canonicalizePostBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CanonicalizeError('body must be a JSON object')
  }
  const font = requireFontId(body.font)
  const format = normalizeFormat(body.format)
  const set = new Set()

  if (body.codepoints != null) {
    if (!Array.isArray(body.codepoints)) {
      throw new CanonicalizeError('codepoints must be an array of numbers/strings')
    }
    for (const value of body.codepoints) addCodepoint(set, value)
  }
  if (body.characters != null) {
    if (typeof body.characters !== 'string') {
      throw new CanonicalizeError('characters must be a string')
    }
    for (const ch of body.characters) {
      const cp = ch.codePointAt(0)
      if (cp != null) addCodepointInt(set, cp)
    }
  }
  if (body.ranges != null) {
    if (!Array.isArray(body.ranges)) {
      throw new CanonicalizeError('ranges must be an array of [lo, hi] pairs')
    }
    for (const range of body.ranges) {
      if (!Array.isArray(range) || range.length !== 2) {
        throw new CanonicalizeError('each range must be a [lo, hi] pair')
      }
      addRange(set, range[0], range[1])
    }
  }

  return finalize(font, set, format)
}

/**
 * Canonicalize a GET query-string shape (URLSearchParams or plain object).
 * `font`, `codepoints`, `characters`, `ranges`, `format`.
 * @param {URLSearchParams | Record<string, string>} params
 */
export function canonicalizeQuery(params) {
  const get = params instanceof URLSearchParams
    ? (k) => params.get(k)
    : (k) => (params && Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null)
  const font = requireFontId(get('font'))
  const format = normalizeFormat(get('format') ?? undefined)
  const set = new Set()

  const cps = get('codepoints')
  if (cps != null && cps !== '') {
    for (const token of splitList(cps)) addCodepoint(set, token)
  }
  const chars = get('characters')
  if (chars != null && chars !== '') {
    for (const ch of chars) {
      const cp = ch.codePointAt(0)
      if (cp != null) addCodepointInt(set, cp)
    }
  }
  const ranges = get('ranges')
  if (ranges != null && ranges !== '') {
    for (const token of splitList(ranges)) {
      const [lo, hi] = parseRangeToken(token)
      addRange(set, lo, hi)
    }
  }

  return finalize(font, set, format)
}

function finalize(font, set, format) {
  if (set.size === 0) {
    throw new CanonicalizeError('at least one of codepoints, characters, or ranges must be provided')
  }
  if (set.size > MAX_CODEPOINTS_PER_REQUEST) {
    throw new CanonicalizeError(
      `too many codepoints: ${set.size} > ${MAX_CODEPOINTS_PER_REQUEST}`,
      { status: 413 },
    )
  }
  const codepoints = [...set].sort((a, b) => a - b)
  return { font, codepoints, format }
}

function requireFontId(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CanonicalizeError('font is required (string)')
  }
  // Be strict — the value lands in a filesystem path. Lowercase letters,
  // digits, hyphen only. The known families (sf-pro, sf-compact, new-york,
  // sf-arabic, sf-armenian, sf-georgian, sf-hebrew) all match.
  if (!/^[a-z0-9-]+$/.test(value)) {
    throw new CanonicalizeError(`invalid font id: ${value}`)
  }
  return value
}

function normalizeFormat(value) {
  if (value == null || value === '') return DEFAULT_FORMAT
  if (typeof value !== 'string') throw new CanonicalizeError('format must be a string')
  const lower = value.toLowerCase()
  if (!ALLOWED_FORMATS.includes(lower)) {
    throw new CanonicalizeError(`invalid format: ${value} (allowed: ${ALLOWED_FORMATS.join(', ')})`)
  }
  return lower
}

function splitList(s) {
  return String(s).split(',').map(t => t.trim()).filter(Boolean)
}

function parseCodepointToken(token) {
  if (typeof token === 'number') return token
  if (typeof token !== 'string') {
    throw new CanonicalizeError(`invalid codepoint: ${token}`)
  }
  const t = token.trim()
  if (t === '') throw new CanonicalizeError('empty codepoint token')
  let n
  if (/^[uU]\+[0-9a-fA-F]+$/.test(t)) {
    n = Number.parseInt(t.slice(2), 16)
  } else if (/^0[xX][0-9a-fA-F]+$/.test(t)) {
    n = Number.parseInt(t.slice(2), 16)
  } else if (/^[0-9]+$/.test(t)) {
    n = Number.parseInt(t, 10)
  } else if (/^[0-9a-fA-F]+$/.test(t) && /[a-fA-F]/.test(t)) {
    // Bare hex with at least one letter (e.g. `1F600`) — interpret as hex
    // so users can paste codepoints from charts without a prefix.
    n = Number.parseInt(t, 16)
  } else {
    throw new CanonicalizeError(`invalid codepoint: ${token}`)
  }
  return n
}

function parseRangeToken(token) {
  // Accept `U+xxxx-U+yyyy`, `0xNN-0xMM`, `lo-hi`. Be careful: `U+0041-U+005A`
  // has TWO `-` if split naively — but the first `-` after the first valid
  // codepoint terminator is the range separator. Split on the last `-`
  // that follows a valid codepoint.
  const t = String(token).trim()
  // The lo half is greedy up to and including its last hex digit; the
  // separator is the next `-`; the hi half is the rest.
  const m = t.match(/^([uU]\+[0-9a-fA-F]+|0[xX][0-9a-fA-F]+|[0-9a-fA-F]+|\d+)-([uU]\+[0-9a-fA-F]+|0[xX][0-9a-fA-F]+|[0-9a-fA-F]+|\d+)$/)
  if (!m) throw new CanonicalizeError(`invalid range: ${token}`)
  return [parseCodepointToken(m[1]), parseCodepointToken(m[2])]
}

function addCodepoint(set, value) {
  const n = parseCodepointToken(value)
  addCodepointInt(set, n)
}

function addCodepointInt(set, n) {
  if (!Number.isInteger(n) || n < 0 || n > UNICODE_MAX) {
    throw new CanonicalizeError(`codepoint out of range: ${n}`)
  }
  set.add(n)
  if (set.size > MAX_CODEPOINTS_PER_REQUEST) {
    throw new CanonicalizeError(
      `too many codepoints: > ${MAX_CODEPOINTS_PER_REQUEST}`,
      { status: 413 },
    )
  }
}

function addRange(set, loRaw, hiRaw) {
  const lo = typeof loRaw === 'number' ? loRaw : parseCodepointToken(loRaw)
  const hi = typeof hiRaw === 'number' ? hiRaw : parseCodepointToken(hiRaw)
  if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 0 || hi < 0 || lo > UNICODE_MAX || hi > UNICODE_MAX) {
    throw new CanonicalizeError(`range endpoint out of range: [${lo}, ${hi}]`)
  }
  if (lo > hi) throw new CanonicalizeError(`range endpoints reversed: [${lo}, ${hi}]`)
  // Pre-check size — a single bad range like `[0, 0x10FFFF]` would
  // otherwise spin for ~17M iterations before the per-add cap fires.
  if (hi - lo + 1 > MAX_CODEPOINTS_PER_REQUEST) {
    throw new CanonicalizeError(
      `range too large: ${hi - lo + 1} > ${MAX_CODEPOINTS_PER_REQUEST}`,
      { status: 413 },
    )
  }
  for (let cp = lo; cp <= hi; cp++) set.add(cp)
  if (set.size > MAX_CODEPOINTS_PER_REQUEST) {
    throw new CanonicalizeError(
      `too many codepoints: > ${MAX_CODEPOINTS_PER_REQUEST}`,
      { status: 413 },
    )
  }
}

/**
 * Compute the canonical JSON string for a SHA-256 cache key. Stable across
 * GET and POST so the LRU and Cloudflare share a single key.
 */
export function canonicalKeyString(canonical) {
  return JSON.stringify({
    font: canonical.font,
    format: canonical.format,
    codepoints: canonical.codepoints,
  })
}
