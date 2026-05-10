// Page TOC active-link highlighter. Watches `<h2>`/`<h3>` sections via
// IntersectionObserver and toggles `.toc-active` on the matching
// `.page-toc a[href^="#"]` link as the user scrolls. The `page-toc:refresh`
// event lets dynamic content (collapsible sections rebuilt by other
// controllers) request a re-scan without reloading the bundle.
let observer = null
let currentActiveId = null

function refresh() {
  if (observer) {
    observer.disconnect()
    observer = null
  }
  currentActiveId = null

  const tocs = [...document.querySelectorAll('.page-toc')]
  if (tocs.length === 0) return

  const sectionMap = new Map()
  for (const toc of tocs) {
    for (const link of toc.querySelectorAll('a[href^="#"]')) {
      const id = link.getAttribute('href')?.slice(1)
      if (!id) continue
      const el = document.getElementById(id)
      if (!el) continue
      const existing = sectionMap.get(id)
      if (existing) {
        existing.links.push(link)
      } else {
        sectionMap.set(id, { id, el, links: [link] })
      }
    }
  }

  if (sectionMap.size === 0) return

  const sections = [...sectionMap.values()]
  const sectionByElement = new Map(sections.map(section => [section.el, section]))

  observer = new IntersectionObserver((entries) => {
    let topEntry = null
    for (const entry of entries) {
      if (entry.isIntersecting) {
        if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
          topEntry = entry
        }
      }
    }

    if (!topEntry) return

    const match = sectionByElement.get(topEntry.target)
    if (!match || match.id === currentActiveId) return

    if (currentActiveId && sectionMap.has(currentActiveId)) {
      for (const link of sectionMap.get(currentActiveId).links) {
        link.classList.remove('toc-active')
      }
    }

    for (const link of match.links) {
      link.classList.add('toc-active')
    }
    currentActiveId = match.id
  }, {
    rootMargin: '-80px 0px -60% 0px',
    threshold: 0,
  })

  for (const section of sections) {
    observer.observe(section.el)
  }
}

export function init() {
  document.addEventListener('page-toc:refresh', refresh)
  refresh()
}
