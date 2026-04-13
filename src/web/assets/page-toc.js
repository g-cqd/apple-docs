;(() => {
  const toc = document.querySelector('.page-toc')
  if (!toc) return

  const links = toc.querySelectorAll('a[href^="#"]')
  if (links.length === 0) return

  // Map each TOC link to the corresponding section element
  const sections = []
  for (const link of links) {
    const id = link.getAttribute('href').slice(1)
    const el = document.getElementById(id)
    if (el) sections.push({ el, link })
  }

  if (sections.length === 0) return

  let currentActive = null

  const observer = new IntersectionObserver((entries) => {
    let topEntry = null
    for (const entry of entries) {
      if (entry.isIntersecting) {
        if (!topEntry || entry.boundingClientRect.top < topEntry.boundingClientRect.top) {
          topEntry = entry
        }
      }
    }
    if (topEntry) {
      const match = sections.find(s => s.el === topEntry.target)
      if (match && match !== currentActive) {
        if (currentActive) currentActive.link.classList.remove('toc-active')
        match.link.classList.add('toc-active')
        currentActive = match
      }
    }
  }, {
    rootMargin: '-80px 0px -60% 0px',
    threshold: 0
  })

  for (const section of sections) {
    observer.observe(section.el)
  }
})()
