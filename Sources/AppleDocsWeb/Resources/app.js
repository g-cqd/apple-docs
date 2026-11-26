// apple-docs web UI — served from /assets/app.js (CSP: script-src 'self'; no inline scripts).
(function () {
  'use strict';
  var root = document.documentElement;
  var storageKey = 'apple-docs-theme';

  try {
    var saved = window.localStorage.getItem(storageKey);
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (error) { /* storage unavailable: follow the system theme */ }

  function currentTheme() {
    var explicit = root.getAttribute('data-theme');
    if (explicit) return explicit;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.addEventListener('DOMContentLoaded', function () {
    var toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var next = currentTheme() === 'dark' ? 'light' : 'dark';
        root.setAttribute('data-theme', next);
        try { window.localStorage.setItem(storageKey, next); } catch (error) { /* ignore */ }
      });
    }
    document.addEventListener('keydown', function (event) {
      var active = document.activeElement;
      var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (event.key === '/' && !typing) {
        var input = document.querySelector('.site-search input');
        if (input) { event.preventDefault(); input.focus(); }
      }
    });
  });
})();
