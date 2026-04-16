import { createHighlighter } from 'shiki'

// Language alias mapping (corpus identifiers -> Shiki grammar names)
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

let _highlighter = null

export async function initHighlighter() {
  if (_highlighter) return
  _highlighter = await createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: [...new Set(Object.values(LANG_MAP))],
  })
}

export function highlightCode(code, lang) {
  const grammar = LANG_MAP[lang?.toLowerCase()] ?? null
  if (!_highlighter || !grammar) {
    // Fall back to plain escaped code
    return null
  }
  return _highlighter.codeToHtml(code, {
    lang: grammar,
    themes: { light: 'github-light', dark: 'github-dark' },
  })
}

export function disposeHighlighter() {
  if (_highlighter) {
    _highlighter.dispose()
    _highlighter = null
  }
}
