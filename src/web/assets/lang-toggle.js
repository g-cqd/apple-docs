// Language toggle controller for the doc page declaration block.
//
// Served as a standalone `<script src="/assets/lang-toggle.js">`, so it
// self-mounts: top-level `init()` runs once when the script loads. No
// exports — the bundler emits a minified IIFE that runs immediately.
const STORAGE_KEY = 'apple-docs-lang'

function readStored() {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function persist(/** @type {any} */ lang) {
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* storage full or disabled */
  }
}

function activate(/** @type {any} */ lang, /** @type {any} */ buttons, /** @type {any} */ variants) {
  for (const btn of buttons) {
    const isActive = btn.dataset.lang === lang
    btn.classList.toggle('active', isActive)
    btn.setAttribute('aria-pressed', String(isActive))
  }
  for (const el of variants) {
    el.hidden = el.dataset.lang !== lang
  }
  persist(lang)
}

function init() {
  const toggle = /** @type {any} */ (document.querySelector('.lang-toggle'))
  if (!toggle) return

  const buttons = /** @type {any} */ (toggle.querySelectorAll('.lang-btn'))
  const variants = /** @type {any} */ (document.querySelectorAll('.decl-variant[data-lang]'))
  if (variants.length === 0) return

  // Collect available languages from the declaration section.
  const declSection = /** @type {any} */ (document.querySelector('[data-languages]'))
  const available = new Set(declSection?.dataset.languages?.split(',') ?? [])

  // Restore preference, or fall back to the first available language (e.g. ObjC-only docs).
  const stored = readStored()
  const fallback = [...available][0] ?? 'swift'
  const initial = stored && available.has(stored) ? stored : fallback
  activate(initial, buttons, variants)

  toggle.addEventListener('click', (/** @type {any} */ e) => {
    const btn = /** @type {any} */ (e.target.closest('.lang-btn'))
    if (!btn || btn.classList.contains('active')) return
    activate(btn.dataset.lang, buttons, variants)
  })
}

init()
