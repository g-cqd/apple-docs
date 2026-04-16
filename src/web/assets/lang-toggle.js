;(() => {
  const STORAGE_KEY = 'apple-docs-lang'
  const toggle = document.querySelector('.lang-toggle')
  if (!toggle) return

  const buttons = toggle.querySelectorAll('.lang-btn')
  const variants = document.querySelectorAll('.decl-variant[data-lang]')
  if (variants.length === 0) return

  // Collect available languages from the declaration section
  const declSection = document.querySelector('[data-languages]')
  const available = new Set(declSection?.dataset.languages?.split(',') ?? [])

  function activate(lang) {
    // Update buttons
    for (const btn of buttons) {
      const isActive = btn.dataset.lang === lang
      btn.classList.toggle('active', isActive)
      btn.setAttribute('aria-pressed', String(isActive))
    }
    // Show/hide declaration variants
    for (const el of variants) {
      el.hidden = el.dataset.lang !== lang
    }
    // Persist
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* storage full or disabled */ }
  }

  // Restore preference, or fall back to the first available language (e.g. ObjC-only docs)
  const stored = (() => { try { return localStorage.getItem(STORAGE_KEY) } catch { return null } })()
  const fallback = [...available][0] ?? 'swift'
  const initial = stored && available.has(stored) ? stored : fallback
  activate(initial)

  // Handle clicks
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.lang-btn')
    if (!btn || btn.classList.contains('active')) return
    activate(btn.dataset.lang)
  })
})()
