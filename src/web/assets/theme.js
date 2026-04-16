;(() => {
  const STORAGE_KEY = 'apple-docs-theme'
  const VALID = ['auto', 'light', 'dark']

  function readPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored && VALID.indexOf(stored) !== -1) return stored
    } catch {}
    return 'auto'
  }

  function savePreference(theme) {
    try { localStorage.setItem(STORAGE_KEY, theme) } catch {}
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme)
  }

  function updateActiveButton(theme) {
    const buttons = document.querySelectorAll('.theme-option')
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i]
      const isActive = btn.getAttribute('data-theme-value') === theme
      btn.classList.toggle('active', isActive)
      btn.setAttribute('aria-checked', String(isActive))
    }
  }

  function setTheme(theme) {
    applyTheme(theme)
    savePreference(theme)
    updateActiveButton(theme)
  }

  // Apply immediately to avoid flash
  const initial = readPreference()
  applyTheme(initial)

  document.addEventListener('DOMContentLoaded', () => {
    updateActiveButton(initial)
    const buttons = document.querySelectorAll('.theme-option')
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', () => {
        setTheme(buttons[i].getAttribute('data-theme-value') || 'auto')
      })
    }
  })
})()
