import { describe, test, expect } from 'bun:test'
import { parseGuidelinesHtml, ROOT_SLUG, GUIDELINES_URL } from '../../src/apple/guidelines-parser.js'

describe('parseGuidelinesHtml', () => {
  function wrapInContainer(content) {
    return `<html><body><div id="content-container">${content}</div></body></html>`
  }

  test('parses a single h3 section', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="1. Safety" id="safety">1. Safety</h3>
      <p>Apps should be safe for users.</p>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections.length).toBe(1)
    expect(sections[0].title).toBe('1. Safety')
    expect(sections[0].role).toBe('collection')
    expect(sections[0].roleHeading).toBe('Section')
    expect(sections[0].id).toBe('safety')
  })

  test('parses li data-sidenav subsections', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="1. Safety" id="safety">1. Safety</h3>
      <ul class="no-bullet">
        <li data-sidenav="1.1 Objectionable Content" id="objectionable-content">
          <p><strong>1.1 Objectionable Content</strong></p>
          <p>Apps should not include offensive content.</p>
        </li>
      </ul>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections.length).toBe(2)

    const subsection = sections[1]
    expect(subsection.title).toBe('1.1 Objectionable Content')
    expect(subsection.role).toBe('article')
    expect(subsection.roleHeading).toBe('Guideline')
    expect(subsection.sectionNumber).toBe('1.1')
    expect(subsection.path).toBe(`${ROOT_SLUG}/1.1`)
  })

  test('builds parent-child hierarchy', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="1. Safety" id="safety">1. Safety</h3>
      <ul class="no-bullet">
        <li data-sidenav="1.1 Objectionable Content" id="objectionable-content">
          <p><strong>1.1 Objectionable Content</strong></p>
        </li>
        <li data-sidenav="1.2 User Generated Content" id="user-generated-content">
          <p><strong>1.2 User Generated Content</strong></p>
        </li>
      </ul>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections.length).toBe(3)

    // The parent (section 1) should have children
    const parent = sections.find(s => s.sectionNumber === '1')
    expect(parent).toBeDefined()
    expect(parent.children.length).toBe(2)
    expect(parent.children).toContain(`${ROOT_SLUG}/1.1`)
    expect(parent.children).toContain(`${ROOT_SLUG}/1.2`)
  })

  test('extracts section numbers from titles', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="5. Legal" id="legal">5. Legal</h3>
      <ul class="no-bullet">
        <li data-sidenav="5.1 Privacy" id="privacy">
          <p><strong>5.1 Privacy</strong></p>
        </li>
        <li data-sidenav="5.1.1 Data Collection" id="data-collection">
          <p><strong>5.1.1 Data Collection</strong></p>
        </li>
      </ul>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    const nums = sections.map(s => s.sectionNumber)
    expect(nums).toContain('5')
    expect(nums).toContain('5.1')
    expect(nums).toContain('5.1.1')
  })

  test('handles notarization (data-nr) attribute', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="2. Performance" data-nr id="performance">2. Performance</h3>
      <p>Apps must perform well.</p>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections[0].notarization).toBe(true)
  })

  test('generates abstract from content', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="3. Business" id="business">3. Business</h3>
      <p>There are many ways to monetize your app. The key point is quality.</p>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections[0].abstract).toBeDefined()
    expect(sections[0].abstract.length).toBeGreaterThan(0)
  })

  test('extracts last updated date', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="1. Safety" id="safety">1. Safety</h3>
      <p>Be safe.</p>
      <p>Last Updated: <a href="#">June 10, 2024</a></p>
    `)

    const { lastUpdated } = await parseGuidelinesHtml(html)
    expect(lastUpdated).toBe('June 10, 2024')
  })

  test('returns null lastUpdated when not found', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav="1. Safety" id="safety">1. Safety</h3>
      <p>Be safe.</p>
    `)

    const { lastUpdated } = await parseGuidelinesHtml(html)
    expect(lastUpdated).toBeNull()
  })

  test('throws when content container is missing', async () => {
    const html = '<html><body><div>No container here</div></body></html>'
    await expect(parseGuidelinesHtml(html)).rejects.toThrow('Could not find #content-container')
  })

  test('handles sections without data-sidenav value gracefully', async () => {
    const html = wrapInContainer(`
      <h3 data-sidenav id="introduction">Introduction</h3>
      <p>Welcome to the guidelines.</p>
    `)

    const { sections } = await parseGuidelinesHtml(html)
    expect(sections.length).toBe(1)
    // Without a data-sidenav value, title falls back to markdown extraction
    expect(sections[0].title).toBeDefined()
  })

  test('ROOT_SLUG and GUIDELINES_URL exports', () => {
    expect(ROOT_SLUG).toBe('app-store-review')
    expect(GUIDELINES_URL).toBe('https://developer.apple.com/app-store/review/guidelines/')
  })
})
