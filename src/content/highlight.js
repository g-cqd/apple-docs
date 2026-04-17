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

export function getHighlighterState() {
  return {
    ready: _highlighter != null,
    warming: _highlighterPromise != null,
  }
}
