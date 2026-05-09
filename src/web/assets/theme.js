// Theme switcher: persists the user's auto/light/dark preference and
// reflects it via `<html data-theme="...">` so the CSS variable layer
// can pick up the right palette.
//
// Phase 2 conversion: the file is a native ES module. The flash-prevention
// step (set data-theme to the stored value) runs as a top-level
// side-effect on module load — that ensures it happens BEFORE any other
// bundle member's IIFE side effects, which is required for the page to
// render with the correct palette. The `init()` export wires up the
// button handlers and runs after DOMContentLoaded (queued via the
// listener); core.bundle.js calls it explicitly.
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

// Module evaluation: set data-theme immediately. This runs the moment the
// bundle's outer IIFE reaches theme.js, BEFORE any sibling member's
// side-effect import — paint never flashes the wrong palette.
const INITIAL_THEME = readPreference()
applyTheme(INITIAL_THEME)

export function init() {
  document.addEventListener('DOMContentLoaded', () => {
    updateActiveButton(INITIAL_THEME)
    const buttons = document.querySelectorAll('.theme-option')
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', () => {
        setTheme(buttons[i].getAttribute('data-theme-value') || 'auto')
      })
    }
  })
}
