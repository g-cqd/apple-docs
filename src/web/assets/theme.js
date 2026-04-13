;(function () {
  'use strict'

  var STORAGE_KEY = 'apple-docs-theme'
  var CYCLE = ['auto', 'light', 'dark']

  /** Read the persisted theme preference, defaulting to 'auto'. */
  function readPreference() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY)
      if (stored && CYCLE.indexOf(stored) !== -1) return stored
    } catch (_) {
      // localStorage unavailable (private browsing, storage disabled)
    }
    return 'auto'
  }

  /** Persist the theme preference to localStorage. */
  function savePreference(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch (_) {
      // Ignore write errors
    }
  }

  /** Apply the given theme value to the <html> element. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme)
  }

  /** Cycle the theme: auto → light → dark → auto */
  function cycleTheme() {
    var current = document.documentElement.getAttribute('data-theme') || 'auto'
    var currentIndex = CYCLE.indexOf(current)
    var nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % CYCLE.length
    var next = CYCLE[nextIndex]
    applyTheme(next)
    savePreference(next)
    updateToggleLabel(next)
  }

  /** Update the toggle button aria-label and symbol to reflect the active theme. */
  function updateToggleLabel(theme) {
    var toggles = document.querySelectorAll('.theme-toggle')
    var labels = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' }
    var symbols = { auto: '\u9680', light: '\u2600\ufe0f', dark: '\uD83C\uDF19' }
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].setAttribute('aria-label', labels[theme] || 'Toggle theme')
      toggles[i].textContent = symbols[theme] || '\u9680'
    }
  }

  // Apply preference immediately to avoid flash of wrong theme
  var initial = readPreference()
  applyTheme(initial)

  // Wire up toggle buttons once the DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    updateToggleLabel(initial)
    var toggles = document.querySelectorAll('.theme-toggle')
    for (var i = 0; i < toggles.length; i++) {
      toggles[i].addEventListener('click', cycleTheme)
    }
  })
})()
