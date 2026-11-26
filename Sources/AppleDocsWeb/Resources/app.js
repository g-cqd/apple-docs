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
    initLanguageToggle();
    initStaticSearch();
    document.addEventListener('keydown', function (event) {
      var active = document.activeElement;
      var typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (event.key === '/' && !typing) {
        var input = document.querySelector('.site-search input');
        if (input) { event.preventDefault(); input.focus(); }
      }
    });
  });

  // Swift / Objective-C declaration variants (`.lang-toggle` + `[data-languages]`), preference persisted.
  function initLanguageToggle() {
    var toggle = document.querySelector('.lang-toggle');
    var variants = document.querySelectorAll('.decl-variant[data-lang]');
    if (!toggle || variants.length === 0) return;
    var buttons = toggle.querySelectorAll('.lang-btn');
    var langKey = 'apple-docs-lang';
    function activate(lang) {
      buttons.forEach(function (button) {
        var active = button.getAttribute('data-lang') === lang;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      variants.forEach(function (variant) { variant.hidden = variant.getAttribute('data-lang') !== lang; });
    }
    var available = (document.querySelector('[data-languages]') || toggle).getAttribute('data-languages') || '';
    var stored = null;
    try { stored = window.localStorage.getItem(langKey); } catch (error) { /* ignore */ }
    if (stored && available.split(',').indexOf(stored) >= 0) activate(stored);
    toggle.addEventListener('click', function (event) {
      var button = event.target.closest('.lang-btn');
      if (!button) return;
      var lang = button.getAttribute('data-lang');
      activate(lang);
      try { window.localStorage.setItem(langKey, lang); } catch (error) { /* ignore */ }
    });
  }

  // Static export search: rank the prebuilt columnar title index (exact, prefix, substring, abstract).
  function initStaticSearch() {
    var list = document.querySelector('[data-static-search]');
    if (!list) return;
    var base = root.getAttribute('data-base') || '';
    var query = new URLSearchParams(window.location.search).get('q') || '';
    var input = document.querySelector('.search-form input[name="q"]');
    if (input) input.value = query;
    var needle = query.trim().toLowerCase();
    if (!needle) return;
    fetch(base + list.getAttribute('data-static-search'))
      .then(function (response) { return response.json(); })
      .then(function (index) {
        var hits = [];
        for (var i = 0; i < index.keys.length; i++) {
          var title = index.titles[i].toLowerCase();
          var rank = title === needle ? 0 : title.indexOf(needle) === 0 ? 1 : title.indexOf(needle) >= 0 ? 2
            : index.abstracts[i].toLowerCase().indexOf(needle) >= 0 ? 3 : -1;
          if (rank >= 0) hits.push([rank, index.titles[i].length, i]);
        }
        hits.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
        list.textContent = '';
        hits.slice(0, 50).forEach(function (hit) {
          var i = hit[2];
          var item = document.createElement('li');
          var link = document.createElement('a');
          link.href = base + '/doc/' + index.keys[i];
          link.textContent = index.titles[i];
          item.appendChild(link);
          var framework = index.frameworks[index.fwIndices[i]];
          if (framework) {
            var badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = framework;
            item.appendChild(badge);
          }
          if (index.abstracts[i]) {
            var abstract = document.createElement('p');
            abstract.textContent = index.abstracts[i];
            item.appendChild(abstract);
          }
          list.appendChild(item);
        });
        if (hits.length === 0) {
          var empty = document.createElement('li');
          empty.className = 'muted';
          empty.textContent = 'No results for \u201c' + query + '\u201d.';
          list.appendChild(empty);
        }
      })
      .catch(function () { list.textContent = 'Search index unavailable.'; });
  }
})();
