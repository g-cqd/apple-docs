import { describe, test, expect } from 'bun:test'
import { normalize, renderContentNodesToText } from '../../src/content/normalize.js'

const fixture = await Bun.file(new URL('../fixtures/swiftui-view.json', import.meta.url)).json()

describe('normalize — Apple DocC', () => {
  test('extracts document metadata from DocC JSON', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(document.sourceType).toBe('apple-docc')
    expect(document.key).toBe('swiftui/view')
    expect(document.title).toBe('View')
    expect(document.role).toBe('symbol')
    expect(document.roleHeading).toBe('Protocol')
    expect(document.framework).toBe('swiftui')
    expect(document.url).toContain('developer.apple.com/documentation/swiftui/view')
    expect(document.language).toBe('swift')
    expect(document.abstractText).toBeTruthy()
    expect(document.declarationText).toContain('View')
    expect(document.isReleaseNotes).toBe(false)
    expect(document.urlDepth).toBe(1)
  })

  test('extracts platform versions', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')

    if (document.platformsJson) {
      const platforms = JSON.parse(document.platformsJson)
      expect(typeof platforms).toBe('object')
    }
  })

  test('produces sections in correct order', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(sections.length).toBeGreaterThan(0)

    // Should be sorted by sortOrder
    for (let i = 1; i < sections.length; i++) {
      expect(sections[i].sortOrder).toBeGreaterThanOrEqual(sections[i - 1].sortOrder)
    }

    // First section should be abstract or have sortOrder 0
    const sectionKinds = sections.map(s => s.sectionKind)
    expect(sectionKinds).toContain('abstract')
  })

  test('extracts abstract section with contentText and contentJson', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const abstract = sections.find(s => s.sectionKind === 'abstract')

    expect(abstract).toBeTruthy()
    expect(abstract.contentText).toBeTruthy()
    expect(abstract.contentJson).toBeTruthy()
    expect(abstract.heading).toBeNull()
  })

  test('extracts declaration section', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const decl = sections.find(s => s.sectionKind === 'declaration')

    expect(decl).toBeTruthy()
    expect(decl.contentText).toContain('View')
    expect(decl.heading).toBe('Declaration')
    expect(decl.contentJson).toBeTruthy()
  })

  test('extracts topics section', () => {
    const { sections } = normalize(fixture, 'swiftui/view', 'apple-docc')
    const topics = sections.find(s => s.sectionKind === 'topics')

    expect(topics).toBeTruthy()
    expect(topics.heading).toBe('Topics')
    expect(topics.contentText).toBeTruthy()
  })

  test('extracts relationships as child/see_also/inherits_from', () => {
    const { relationships } = normalize(fixture, 'swiftui/view', 'apple-docc')

    expect(relationships.length).toBeGreaterThan(0)

    const types = new Set(relationships.map(r => r.relationType))
    // View should have at least child relations (from topics)
    expect(types.has('child')).toBe(true)

    // All relationships should have fromKey = our key
    for (const rel of relationships) {
      expect(rel.fromKey).toBe('swiftui/view')
      expect(rel.toKey).toBeTruthy()
    }
  })

  test('headings field contains section heading text', () => {
    const { document } = normalize(fixture, 'swiftui/view', 'apple-docc')
    // headings may be null if no content sections with headings
    if (document.headings) {
      expect(typeof document.headings).toBe('string')
    }
  })

  test('handles empty/minimal JSON gracefully', () => {
    const { document, sections, relationships } = normalize({}, 'test/empty', 'apple-docc')

    expect(document.key).toBe('test/empty')
    expect(document.title).toBeNull()
    expect(sections.length).toBe(0)
    expect(relationships.length).toBe(0)
  })

  test('handles null payload gracefully', () => {
    const { document } = normalize(null, 'test/null', 'apple-docc')
    expect(document.key).toBe('test/null')
  })
})

describe('normalize — Guidelines', () => {
  test('normalizes guideline section', () => {
    const section = {
      title: '1.1 - App Completeness',
      role: 'article',
      roleHeading: 'Section',
      path: 'app-store-review/1.1',
      markdown: 'Submissions must be final versions.',
      abstract: 'Submissions must be final.',
      id: '1.1',
      children: ['app-store-review/1.1.1'],
    }

    const { document, sections, relationships } = normalize(section, 'app-store-review/1.1', 'guidelines')

    expect(document.sourceType).toBe('guidelines')
    expect(document.framework).toBe('app-store-review')
    expect(document.title).toBe('1.1 - App Completeness')

    expect(sections.length).toBe(2) // abstract + discussion
    expect(sections[0].sectionKind).toBe('abstract')
    expect(sections[1].sectionKind).toBe('discussion')

    expect(relationships.length).toBe(1)
    expect(relationships[0].relationType).toBe('child')
    expect(relationships[0].toKey).toBe('app-store-review/1.1.1')
  })

  test('handles guideline with no children', () => {
    const section = {
      title: 'Leaf Section',
      role: 'article',
      path: 'app-store-review/leaf',
      markdown: 'Content here.',
      abstract: null,
      children: [],
    }

    const { relationships } = normalize(section, 'app-store-review/leaf', 'guidelines')
    expect(relationships.length).toBe(0)
  })
})

describe('renderContentNodesToText', () => {
  test('renders paragraph to text', () => {
    const nodes = [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Hello world' }] }]
    expect(renderContentNodesToText(nodes, {})).toContain('Hello world')
  })

  test('renders heading to text', () => {
    const nodes = [{ type: 'heading', level: 2, text: 'Overview' }]
    expect(renderContentNodesToText(nodes, {})).toContain('Overview')
  })

  test('renders codeListing to text', () => {
    const nodes = [{ type: 'codeListing', syntax: 'swift', code: ['let x = 1', 'print(x)'] }]
    const text = renderContentNodesToText(nodes, {})
    expect(text).toContain('let x = 1')
    expect(text).toContain('print(x)')
  })

  test('renders unorderedList to text', () => {
    const nodes = [{
      type: 'unorderedList',
      items: [
        { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Item A' }] }] },
        { content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Item B' }] }] },
      ],
    }]
    const text = renderContentNodesToText(nodes, {})
    expect(text).toContain('Item A')
    expect(text).toContain('Item B')
  })

  test('renders codeVoice inline', () => {
    const nodes = [{ type: 'paragraph', inlineContent: [
      { type: 'text', text: 'Use ' },
      { type: 'codeVoice', code: 'View' },
      { type: 'text', text: ' protocol' },
    ]}]
    expect(renderContentNodesToText(nodes, {})).toContain('Use View protocol')
  })

  test('handles empty/null input', () => {
    expect(renderContentNodesToText(null, {})).toBe('')
    expect(renderContentNodesToText([], {})).toBe('')
    expect(renderContentNodesToText(undefined, {})).toBe('')
  })
})

// ---------------------------------------------------------------------------
// New section types: properties, REST, possibleValues, mentions, fallback
// ---------------------------------------------------------------------------

describe('normalize — properties section', () => {
  const payload = {
    metadata: { title: 'MyResponse', role: 'symbol', roleHeading: 'Object' },
    abstract: [{ type: 'text', text: 'A response object.' }],
    primaryContentSections: [
      {
        kind: 'properties',
        title: 'Properties',
        items: [
          {
            name: 'signedInfo',
            type: [{ kind: 'typeIdentifier', text: 'JWSTransaction', identifier: 'doc://com.apple/JWSTransaction' }],
            content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Signed transaction info.' }] }],
            required: false,
            attributes: [],
          },
        ],
      },
    ],
    references: {
      'doc://com.apple/JWSTransaction': { url: '/documentation/api/jwstransaction', title: 'JWSTransaction' },
    },
  }

  test('extracts properties section', () => {
    const { sections } = normalize(payload, 'api/myresponse', 'apple-docc')
    const props = sections.find(s => s.sectionKind === 'properties')
    expect(props).toBeTruthy()
    expect(props.heading).toBe('Properties')
    expect(props.contentText).toContain('signedInfo')
  })

  test('stores structured contentJson with resolved type keys', () => {
    const { sections } = normalize(payload, 'api/myresponse', 'apple-docc')
    const props = sections.find(s => s.sectionKind === 'properties')
    const items = JSON.parse(props.contentJson)
    expect(items).toHaveLength(1)
    expect(items[0].name).toBe('signedInfo')
    expect(items[0].type[0]._resolvedKey).toBe('api/jwstransaction')
  })
})

describe('normalize — REST endpoint sections', () => {
  const payload = {
    metadata: { title: 'Get Statuses', role: 'symbol', roleHeading: 'Web Service Endpoint' },
    abstract: [{ type: 'text', text: 'Get subscription statuses.' }],
    primaryContentSections: [
      {
        kind: 'restEndpoint',
        title: 'URL',
        tokens: [
          { kind: 'method', text: 'GET' },
          { kind: 'text', text: ' ' },
          { kind: 'baseURL', text: 'https://api.example.com/' },
          { kind: 'path', text: 'v1/subscriptions/' },
          { kind: 'parameter', text: '{id}' },
        ],
      },
      {
        kind: 'restParameters',
        title: 'Path Parameters',
        source: 'path',
        items: [
          {
            name: 'id',
            type: [{ kind: 'typeIdentifier', text: 'string' }],
            content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'The transaction ID.' }] }],
            required: true,
          },
        ],
      },
      {
        kind: 'restResponses',
        title: 'Response Codes',
        items: [
          { status: 200, reason: 'OK', mimeType: 'application/json', type: [], content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Success.' }] }] },
          { status: 401, reason: 'Unauthorized', type: [], content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Invalid token.' }] }] },
        ],
      },
    ],
    references: {},
  }

  test('extracts rest_endpoint section', () => {
    const { sections } = normalize(payload, 'api/get-statuses', 'apple-docc')
    const endpoints = sections.filter(s => s.sectionKind === 'rest_endpoint')
    expect(endpoints).toHaveLength(1)
    expect(endpoints[0].heading).toBe('URL')
    expect(endpoints[0].contentText).toContain('GET')
    expect(endpoints[0].contentText).toContain('https://api.example.com/')
  })

  test('extracts rest_parameters section', () => {
    const { sections } = normalize(payload, 'api/get-statuses', 'apple-docc')
    const params = sections.find(s => s.sectionKind === 'rest_parameters')
    expect(params).toBeTruthy()
    expect(params.heading).toBe('Path Parameters')
    const items = JSON.parse(params.contentJson)
    expect(items[0].name).toBe('id')
    expect(items[0].required).toBe(true)
  })

  test('extracts rest_responses section', () => {
    const { sections } = normalize(payload, 'api/get-statuses', 'apple-docc')
    const responses = sections.find(s => s.sectionKind === 'rest_responses')
    expect(responses).toBeTruthy()
    expect(responses.heading).toBe('Response Codes')
    const items = JSON.parse(responses.contentJson)
    expect(items).toHaveLength(2)
    expect(items[0].status).toBe(200)
    expect(items[1].status).toBe(401)
  })
})

describe('normalize — possibleValues section', () => {
  const payload = {
    metadata: { title: 'Status', role: 'symbol' },
    abstract: [{ type: 'text', text: 'A status value.' }],
    primaryContentSections: [
      {
        kind: 'possibleValues',
        title: 'Possible Values',
        values: [
          { name: '1', content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Active.' }] }] },
          { name: '2', content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Expired.' }] }] },
        ],
      },
    ],
    references: {},
  }

  test('extracts possible_values section', () => {
    const { sections } = normalize(payload, 'api/status', 'apple-docc')
    const pv = sections.find(s => s.sectionKind === 'possible_values')
    expect(pv).toBeTruthy()
    expect(pv.heading).toBe('Possible Values')
    const values = JSON.parse(pv.contentJson)
    expect(values).toHaveLength(2)
    expect(values[0].name).toBe('1')
  })
})

describe('normalize — mentions section', () => {
  const payload = {
    metadata: { title: 'MyAPI', role: 'symbol' },
    abstract: [{ type: 'text', text: 'An API.' }],
    primaryContentSections: [
      {
        kind: 'mentions',
        mentions: [
          'doc://com.apple/documentation/changelog',
          'doc://com.apple/documentation/guide',
        ],
      },
    ],
    references: {
      'doc://com.apple/documentation/changelog': { url: '/documentation/changelog', title: 'API Changelog' },
      'doc://com.apple/documentation/guide': { url: '/documentation/guide', title: 'Getting Started' },
    },
  }

  test('extracts mentioned_in section', () => {
    const { sections } = normalize(payload, 'api/myapi', 'apple-docc')
    const mi = sections.find(s => s.sectionKind === 'mentioned_in')
    expect(mi).toBeTruthy()
    expect(mi.heading).toBe('Mentioned in')
    const items = JSON.parse(mi.contentJson)
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('API Changelog')
    expect(items[0].key).toBe('changelog')
  })
})

describe('normalize — unknown section fallback', () => {
  const payload = {
    metadata: { title: 'Test', role: 'symbol' },
    abstract: [{ type: 'text', text: 'Test.' }],
    primaryContentSections: [
      {
        kind: 'someFutureKind',
        title: 'Future Section',
        content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Future content.' }] }],
      },
    ],
    references: {},
  }

  test('captures unknown sections as discussion fallback', () => {
    const { sections } = normalize(payload, 'test/page', 'apple-docc')
    const discussion = sections.find(s => s.sectionKind === 'discussion' && s.heading === 'Future Section')
    expect(discussion).toBeTruthy()
    expect(discussion.contentText).toContain('Future content')
  })
})
