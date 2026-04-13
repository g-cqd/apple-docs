;(() => {
  const STORAGE_KEY = 'apple-docs-theme'
  const CYCLE = ['auto', 'light', 'dark']

  /** Read the persisted theme preference, defaulting to 'auto'. */
  function readPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY)
      if (stored && CYCLE.indexOf(stored) !== -1) return stored
    } catch {
      // localStorage unavailable (private browsing, storage disabled)
    }
    return 'auto'
  }

  /** Persist the theme preference to localStorage. */
  function savePreference(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // Ignore write errors
    }
  }

  /** Apply the given theme value to the <html> element. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme)
  }

  /** Cycle the theme: auto -> light -> dark -> auto */
  function cycleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'auto'
    const currentIndex = CYCLE.indexOf(current)
    const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % CYCLE.length
    const next = CYCLE[nextIndex]
    applyTheme(next)
    savePreference(next)
    updateToggleLabel(next)
  }

  /** Update the toggle button aria-label and symbol to reflect the active theme. */
  function updateToggleLabel(theme) {
    const toggles = document.querySelectorAll('.theme-toggle')
    const labels = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' }
    const symbols = { auto: '\u9680', light: '\u2600\ufe0f', dark: '\uD83C\uDF19' }
    for (let i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute('aria-label', labels[theme] || 'Toggle theme')
      toggles[i].textContent = symbols[theme] || '\u9680'
    }
  }

  // Apply preference immediately to avoid flash of wrong theme
  const initial = readPreference()
  applyTheme(initial)

  // Wire up toggle buttons once the DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    updateToggleLabel(initial)
    const toggles = document.querySelectorAll('.theme-toggle')
    for (let i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', cycleTheme)
    }
  })
})()
