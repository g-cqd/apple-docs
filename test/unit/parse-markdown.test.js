import { describe, test, expect } from 'bun:test'
import {
  extractFrontmatter,
  splitByHeadings,
  parseMarkdownToSections,
} from '../../src/content/parse-markdown.js'

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

describe('extractFrontmatter', () => {
  test('parses YAML between --- delimiters', () => {
    const input = `---
title: Swift Evolution Proposal
author: John Appleseed
status: Implemented
---

# Body content here
`
    const { frontmatter, body } = extractFrontmatter(input)

    expect(frontmatter).not.toBeNull()
    expect(frontmatter.title).toBe('Swift Evolution Proposal')
    expect(frontmatter.author).toBe('John Appleseed')
    expect(frontmatter.status).toBe('Implemented')
    expect(body.trim()).toBe('# Body content here')
  })

  test('returns null frontmatter when none present', () => {
    const input = '# Just a heading\n\nSome content.'
    const { frontmatter, body } = extractFrontmatter(input)

    expect(frontmatter).toBeNull()
    expect(body).toBe(input)
  })

  test('parses list values in frontmatter', () => {
    const input = `---
tags:
  - swift
  - evolution
  - generics
---

Content.
`
    const { frontmatter } = extractFrontmatter(input)

    expect(Array.isArray(frontmatter.tags)).toBe(true)
    expect(frontmatter.tags).toContain('swift')
    expect(frontmatter.tags).toContain('evolution')
    expect(frontmatter.tags).toContain('generics')
  })

  test('parses quoted string values', () => {
    const input = `---
title: "Quoted Title: With Colon"
description: 'Single quoted'
---

Body.
`
    const { frontmatter } = extractFrontmatter(input)

    expect(frontmatter.title).toBe('Quoted Title: With Colon')
    expect(frontmatter.description).toBe('Single quoted')
  })

  test('returns empty body string when markdown is empty', () => {
    const { frontmatter, body } = extractFrontmatter('')
    expect(frontmatter).toBeNull()
    expect(body).toBe('')
  })

  test('handles frontmatter-only file with no body', () => {
    const input = `---
title: Minimal
---
`
    const { frontmatter, body } = extractFrontmatter(input)
    expect(frontmatter.title).toBe('Minimal')
    expect(body.trim()).toBe('')
  })
})

// ---------------------------------------------------------------------------
// splitByHeadings
// ---------------------------------------------------------------------------

describe('splitByHeadings', () => {
  test('splits on ## headings correctly', () => {
    const body = `## Overview

This is the overview section.

## Details

These are the details.

## Summary

A brief summary.
`
    const sections = splitByHeadings(body)

    expect(sections.length).toBe(3)
    expect(sections[0].heading).toBe('Overview')
    expect(sections[0].content).toContain('overview section')
    expect(sections[1].heading).toBe('Details')
    expect(sections[2].heading).toBe('Summary')
  })

  test('handles content before first heading as null-heading section', () => {
    const body = `This is an intro paragraph.

More intro content.

## First Section

Section content.
`
    const sections = splitByHeadings(body)

    expect(sections.length).toBe(2)
    expect(sections[0].heading).toBeNull()
    expect(sections[0].content).toContain('intro paragraph')
    expect(sections[1].heading).toBe('First Section')
  })

  test('respects level parameter for ### headings', () => {
    const body = `### Alpha

Alpha content.

### Beta

Beta content.
`
    const sections = splitByHeadings(body, 3)

    expect(sections.length).toBe(2)
    expect(sections[0].heading).toBe('Alpha')
    expect(sections[1].heading).toBe('Beta')
  })

  test('does not split on deeper headings than the specified level', () => {
    const body = `## Top Level

### Sub-section inside top
`
    const sections = splitByHeadings(body, 2)

    expect(sections.length).toBe(1)
    expect(sections[0].heading).toBe('Top Level')
    expect(sections[0].content).toContain('Sub-section inside top')
  })

  test('returns empty array for empty input', () => {
    expect(splitByHeadings('')).toEqual([])
    expect(splitByHeadings('   \n  ')).toEqual([])
  })

  test('returns single section with null heading when no headings found', () => {
    const body = 'Just a paragraph with no headings.'
    const sections = splitByHeadings(body)

    expect(sections.length).toBe(1)
    expect(sections[0].heading).toBeNull()
    expect(sections[0].content).toBe(body)
  })

  test('trims section content', () => {
    const body = `## Section

  Content with leading/trailing whitespace.
`
    const sections = splitByHeadings(body, 2)
    expect(sections[0].content).toBe('Content with leading/trailing whitespace.')
  })
})

// ---------------------------------------------------------------------------
// parseMarkdownToSections
// ---------------------------------------------------------------------------

describe('parseMarkdownToSections', () => {
  const sampleMarkdown = `---
title: Async/Await Proposal
status: Implemented
---

# SE-0296: Async/Await

Swift concurrency is a core language feature that makes it easy to write
safe asynchronous code.

## Motivation

Callback-based code is hard to read and reason about.

## Proposed Solution

Introduce \`async\` functions and \`await\` expressions.

## Detailed Design

The \`async\` keyword marks a function as asynchronous.
`

  test('produces valid document with title from # heading', () => {
    const { document } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
      framework: 'swift-evolution',
    })

    expect(document.title).toBe('SE-0296: Async/Await')
    expect(document.key).toBe('swift-evolution/SE-0296')
    expect(document.sourceType).toBe('swift-evolution')
    expect(document.framework).toBe('swift-evolution')
    expect(document.kind).toBe('article')
    expect(document.role).toBe('article')
    expect(document.roleHeading).toBeNull()
    expect(document.declarationText).toBeNull()
    expect(document.platformsJson).toBeNull()
    expect(document.isDeprecated).toBe(false)
    expect(document.isBeta).toBe(false)
    expect(document.isReleaseNotes).toBe(false)
    expect(document.urlDepth).toBe(1)
  })

  test('uses frontmatter title as fallback when no # heading present', () => {
    const md = `---
title: Frontmatter Title
---

Some content without an H1.
`
    const { document } = parseMarkdownToSections(md, 'some/key', { sourceType: 'test' })
    expect(document.title).toBe('Frontmatter Title')
  })

  test('extracts abstract from first paragraph of body', () => {
    const { document } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    expect(document.abstractText).toBeTruthy()
    expect(document.abstractText).toContain('Swift concurrency')
  })

  test('creates discussion sections for each ## block', () => {
    const { sections } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    const discussions = sections.filter(s => s.sectionKind === 'discussion')
    expect(discussions.length).toBe(3)

    const headings = discussions.map(s => s.heading)
    expect(headings).toContain('Motivation')
    expect(headings).toContain('Proposed Solution')
    expect(headings).toContain('Detailed Design')
  })

  test('creates abstract section as the first section', () => {
    const { sections } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    expect(sections.length).toBeGreaterThan(0)
    expect(sections[0].sectionKind).toBe('abstract')
    expect(sections[0].heading).toBeNull()
    expect(sections[0].contentText).toContain('Swift concurrency')
  })

  test('sections have ascending sortOrder values', () => {
    const { sections } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].sortOrder).toBeGreaterThan(sections[i - 1].sortOrder)
    }
  })

  test('relationships array is always empty', () => {
    const { relationships } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    expect(Array.isArray(relationships)).toBe(true)
    expect(relationships.length).toBe(0)
  })

  test('applies opts fields to document', () => {
    const { document } = parseMarkdownToSections('# Title\n\nContent.', 'pkg/doc', {
      sourceType: 'swift-book',
      kind: 'guide',
      framework: 'swift',
      url: 'https://docs.swift.org/swift-book/doc',
      language: 'swift',
      sourceMetadata: { version: '5.9' },
    })

    expect(document.kind).toBe('guide')
    expect(document.url).toBe('https://docs.swift.org/swift-book/doc')
    expect(document.language).toBe('swift')
    expect(document.sourceMetadata).toEqual({ version: '5.9' })
  })

  test('computes urlDepth correctly', () => {
    const { document: d1 } = parseMarkdownToSections('# T\n\nA.', 'a/b/c', {})
    const { document: d2 } = parseMarkdownToSections('# T\n\nA.', 'a', {})

    expect(d1.urlDepth).toBe(2)
    expect(d2.urlDepth).toBe(0)
  })

  test('collects ## heading texts into document.headings for FTS', () => {
    const { document } = parseMarkdownToSections(sampleMarkdown, 'swift-evolution/SE-0296', {
      sourceType: 'swift-evolution',
    })

    expect(document.headings).toBeTruthy()
    expect(document.headings).toContain('Motivation')
    expect(document.headings).toContain('Proposed Solution')
    expect(document.headings).toContain('Detailed Design')
  })

  test('handles markdown with no frontmatter and no # heading gracefully', () => {
    const md = 'Just some raw content without any headings or frontmatter.'
    const { document, sections, relationships } = parseMarkdownToSections(md, 'misc/raw', {
      sourceType: 'swift-book',
    })

    expect(document.title).toBeNull()
    expect(document.abstractText).toBe(md)
    expect(sections.length).toBe(1)
    expect(sections[0].sectionKind).toBe('abstract')
    expect(relationships.length).toBe(0)
  })

  test('handles empty markdown gracefully', () => {
    const { document, sections, relationships } = parseMarkdownToSections('', 'empty/doc', {})

    expect(document.title).toBeNull()
    expect(document.abstractText).toBeNull()
    expect(sections.length).toBe(0)
    expect(relationships.length).toBe(0)
  })
})
