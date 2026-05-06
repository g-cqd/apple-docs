import { createHighlighter } from 'shiki'
import { createLru } from '../lib/lru.js'
import { sha256 } from '../lib/hash.js'

const LANG_MAP = {
  swift: 'swift', occ: 'objective-c', objc: 'objective-c',
  'objective-c': 'objective-c', 'obj-c': 'objective-c',
  data: 'xml', plist: 'xml', json: 'json', json5: 'json', jsonc: 'json',
  javascript: 'javascript', js: 'javascript', c: 'c',
  shell: 'shellscript', sh: 'shellscript', bash: 'shellscript',
  zsh: 'shellscript', console: 'shellscript',
  xml: 'xml', cpp: 'cpp', 'c++': 'cpp', metal: 'cpp',
  html: 'html', python: 'python', http: 'http', https: 'http',
  diff: 'diff', md: 'markdown', markdown: 'markdown', css: 'css',
}

const THEMES = ['github-light', 'github-dark']
const LANGS = [...new Set(Object.values(LANG_MAP))]

/**
 * Maximum code-block size we will run through shiki. Above this we fall
 * through to a plain `<pre><code>` wrap.
 *
 * Why: shiki's TextMate grammars are prone to catastrophic backtracking on
 * pathological input (long string literals, deeply nested generics,
 * malformed snippets in proposals). The full static build of swift-evolution
 * has hit this empirically — a single 13 KB Swift block pinned a worker's
 * JS thread for minutes, blocking the `Promise.race` timeout from ever
 * firing because there was no event-loop turn to schedule the timer in.
 *
 * 8 KB covers the long tail of real code blocks while reliably sidestepping
 * the slowdowns. Override via `APPLE_DOCS_HIGHLIGHT_MAX` if you need to
 * chase a specific case.
 */
const HIGHLIGHT_MAX_BYTES = Math.max(
  256,
  Number.parseInt(process.env.APPLE_DOCS_HIGHLIGHT_MAX ?? '', 10) || 8 * 1024,
)

let _highlighter = null
let _highlighterPromise = null
const _highlightCache = createLru({ max: 1000 })

export function initHighlighter() {
  if (_highlighter) return Promise.resolve(_highlighter)
  _highlighterPromise ??= createHighlighter({
    themes: THEMES,
    langs: LANGS,
  }).then((highlighter) => {
    _highlighter = highlighter
    return highlighter
  }).catch((error) => {
    _highlighterPromise = null
    throw error
  })
  return _highlighterPromise
}

export function highlightCode(code, lang) {
  const grammar = LANG_MAP[lang?.toLowerCase()] ?? null
  if (!grammar) return null
  if (!_highlighter) {
    if (_highlighterPromise == null) {
      void initHighlighter().catch(() => {})
    }
    return null
  }

  // Bail before invoking shiki on pathologically large blocks — see the
  // HIGHLIGHT_MAX_BYTES comment for the exact failure mode this guards.
  if (typeof code === 'string' && code.length > HIGHLIGHT_MAX_BYTES) {
    return null
  }

  const cacheKey = sha256(code + '\0' + grammar).slice(0, 16)
  const cached = _highlightCache.get(cacheKey)
  if (cached !== undefined) return cached

  const html = _highlighter.codeToHtml(code, {
    lang: grammar,
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  })
  return _highlightCache.set(cacheKey, html)
}

export function disposeHighlighter() {
  if (_highlighter) {
    _highlighter.dispose()
    _highlighter = null
  }
  _highlighterPromise = null
}
