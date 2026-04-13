;(() => {
  const toc = document.querySelector('.page-toc')
  if (!toc) return

  const links = toc.querySelectorAll('a[href^="#"]')
  if (links.length === 0) return

  // Map each TOC link to the corresponding section element
  const sections = []
  links.forEach(link => {
    const id = link.getAttribute('href').slice(1)
    const el = document.getElementById(id)
    if (el) sections.push({ el, link })
  })

  if (sections.length === 0) return

  let currentActive = null

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        const match = sections.find(s => s.el === entry.target)
        if (match) {
          if (currentActive) currentActive.link.classList.remove('toc-active')
          match.link.classList.add('toc-active')
          currentActive = match
        }
      }
    }
  }, {
    rootMargin: '-80px 0px -60% 0px',
    threshold: 0
  })

  sections.forEach(s => observer.observe(s.el))
})()
