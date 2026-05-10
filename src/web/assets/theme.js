// Theme switcher: persists the user's auto/light/dark preference and
// reflects it via `<html data-theme="...">` so the CSS variable layer
// can pick up the right palette.
//
// The flash-prevention step (set data-theme to the stored value) runs
// as a top-level side-effect on module load so it happens BEFORE any
// other bundle member's side effects — required for the page to render
// with the correct palette. The `init()` export wires up the button
// handlers and is called explicitly by the bundle entry after
// DOMContentLoaded.
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
