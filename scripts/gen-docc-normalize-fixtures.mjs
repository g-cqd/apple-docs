// Generate the DocC-normalizer parity golden for the native port
// (swift/Sources/ADBuilder/Sources/DocC). The JS `normalize()` is the oracle: for
// each case we pin `{ input (raw DocC JSON text), expected (normalized doc) }`, and
// the Swift `DocC.normalizeDocC` must reproduce `expected` field-for-field — INCLUDING
// every `contentJson` string, which must match JS `JSON.stringify` byte-for-byte.
//
// Run: bun scripts/gen-docc-normalize-fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize } from '../src/content/normalize.js'
import { extractReferences } from '../src/apple/extractor.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'swift', 'Tests', 'ADBuilderTests', 'Fixtures', 'DocCNormalize', 'cases.json')

const swiftuiView = await Bun.file(join(ROOT, 'test', 'fixtures', 'swiftui-view.json')).json()

// ── Synthetic payloads exercising every section kind + the cross-source link rules
// (mirrors test/unit/content/normalize.test.js). ────────────────────────────────────

const propertiesPayload = {
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

const restPayload = {
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
        {
          status: 200,
          reason: 'OK',
          mimeType: 'application/json',
          type: [],
          content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Success.' }] }],
        },
        { status: 401, reason: 'Unauthorized', type: [], content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'Invalid token.' }] }] },
      ],
    },
  ],
  references: {},
}

const possibleValuesPayload = {
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

const mentionsPayload = {
  metadata: { title: 'MyAPI', role: 'symbol' },
  abstract: [{ type: 'text', text: 'An API.' }],
  primaryContentSections: [
    { kind: 'mentions', mentions: ['doc://com.apple/documentation/changelog', 'doc://com.apple/documentation/guide'] },
  ],
  references: {
    'doc://com.apple/documentation/changelog': { url: '/documentation/changelog', title: 'API Changelog' },
    'doc://com.apple/documentation/guide': { url: '/documentation/guide', title: 'Getting Started' },
  },
}

const fallbackPayload = {
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

const archiveRefPayload = {
  schemaVersion: { major: 0, minor: 3, patch: 0 },
  identifier: { url: 'doc://com.apple.foo/documentation/foo/bar' },
  metadata: { title: 'Bar', role: 'article' },
  kind: 'article',
  abstract: [],
  sections: [],
  primaryContentSections: [
    { kind: 'content', content: [{ type: 'paragraph', inlineContent: [{ type: 'reference', identifier: 'apple-archive-ref' }] }] },
  ],
  topicSections: [],
  seeAlsoSections: [],
  references: {
    'apple-archive-ref': {
      identifier: 'apple-archive-ref',
      title: 'GameplayKit Programming Guide',
      type: 'topic',
      url: 'https://developer.apple.com/library/archive/documentation/General/Conceptual/GameplayKit_Guide/index.html',
    },
  },
}

const wwdcLinkPayload = {
  schemaVersion: { major: 0, minor: 3, patch: 0 },
  identifier: { url: 'doc://x/documentation/x' },
  metadata: { title: 'X' },
  kind: 'article',
  abstract: [],
  sections: [],
  primaryContentSections: [
    {
      kind: 'content',
      content: [
        {
          type: 'paragraph',
          inlineContent: [{ type: 'link', destination: 'https://developer.apple.com/videos/play/wwdc2024/10001/', title: 'Session 10001' }],
        },
      ],
    },
  ],
  topicSections: [],
  seeAlsoSections: [],
  references: {},
}

const externalLinkPayload = {
  schemaVersion: { major: 0, minor: 3, patch: 0 },
  identifier: { url: 'doc://x/documentation/x' },
  metadata: { title: 'X' },
  kind: 'article',
  abstract: [],
  sections: [],
  primaryContentSections: [
    {
      kind: 'content',
      content: [{ type: 'paragraph', inlineContent: [{ type: 'link', destination: 'https://forums.swift.org/t/123', title: 'Forum thread' }] }],
    },
  ],
  topicSections: [],
  seeAlsoSections: [],
  references: {},
}

// A termList + aside + platforms + deprecated/beta exerciser (discussion resolveContentReferences
// over nested inlineContent, and the document platform/version + flags).
const richDiscussionPayload = {
  metadata: {
    title: 'RichView',
    role: 'symbol',
    symbolKind: 'class',
    roleHeading: 'Class',
    deprecated: true,
    beta: true,
    modules: [{ name: 'RichKit' }],
    platforms: [
      { name: 'iOS', introducedAt: '17.0' },
      { name: 'macOS', introducedAt: '14.0' },
      { name: 'Mac Catalyst', introducedAt: '17.0' },
    ],
  },
  abstract: [{ type: 'text', text: 'A rich view.' }],
  primaryContentSections: [
    {
      kind: 'declarations',
      declarations: [
        {
          languages: ['swift'],
          tokens: [
            { kind: 'keyword', text: 'class ' },
            { kind: 'identifier', text: 'RichView' },
            { kind: 'text', text: ' : ' },
            { kind: 'typeIdentifier', text: 'View', identifier: 'doc://com.apple.SwiftUI/documentation/SwiftUI/View' },
          ],
        },
      ],
    },
    {
      kind: 'content',
      content: [
        { type: 'heading', level: 2, text: 'Overview' },
        {
          type: 'termList',
          items: [
            {
              term: { inlineContent: [{ type: 'text', text: 'Term A' }] },
              definition: { content: [{ type: 'paragraph', inlineContent: [{ type: 'reference', identifier: 'doc://com.apple.SwiftUI/documentation/SwiftUI/View' }] }] },
            },
          ],
        },
        { type: 'aside', style: 'note', content: [{ type: 'paragraph', inlineContent: [{ type: 'text', text: 'A note.' }] }] },
      ],
    },
  ],
  topicSections: [
    { title: 'Creating a View', identifiers: ['doc://com.apple.SwiftUI/documentation/SwiftUI/View'] },
  ],
  relationshipsSections: [
    { type: 'conformsTo', title: 'Conforms To', identifiers: ['doc://com.apple.SwiftUI/documentation/SwiftUI/View'] },
  ],
  seeAlsoSections: [
    { title: 'Related', identifiers: ['doc://com.apple.SwiftUI/documentation/SwiftUI/View'] },
  ],
  references: {
    'doc://com.apple.SwiftUI/documentation/SwiftUI/View': {
      url: '/documentation/swiftui/view',
      title: 'View',
    },
  },
}

const rawCases = [
  { name: 'swiftui-view', key: 'swiftui/view', sourceType: 'apple-docc', input: swiftuiView },
  { name: 'properties', key: 'api/myresponse', sourceType: 'apple-docc', input: propertiesPayload },
  { name: 'rest', key: 'api/get-statuses', sourceType: 'apple-docc', input: restPayload },
  { name: 'possible-values', key: 'api/status', sourceType: 'apple-docc', input: possibleValuesPayload },
  { name: 'mentions', key: 'api/myapi', sourceType: 'apple-docc', input: mentionsPayload },
  { name: 'fallback', key: 'test/page', sourceType: 'apple-docc', input: fallbackPayload },
  { name: 'archive-ref', key: 'foo/bar', sourceType: 'apple-docc', input: archiveRefPayload },
  { name: 'wwdc-link', key: 'x', sourceType: 'apple-docc', input: wwdcLinkPayload },
  { name: 'external-link', key: 'x', sourceType: 'apple-docc', input: externalLinkPayload },
  { name: 'rich-discussion', key: 'richkit/richview', sourceType: 'apple-docc', input: richDiscussionPayload },
  { name: 'hig', key: 'design/foundations/color', sourceType: 'hig', input: propertiesPayload },
  { name: 'swift-docc', key: 'documentation/foo', sourceType: 'swift-docc', input: possibleValuesPayload },
  { name: 'empty', key: 'test/empty', sourceType: 'apple-docc', input: {} },
]

const cases = rawCases.map((c) => ({
  name: c.name,
  key: c.key,
  sourceType: c.sourceType,
  input: JSON.stringify(c.input),
  expected: normalize(c.input, c.key, c.sourceType),
  expectedReferences: extractReferences(c.input),
}))

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(cases))
console.log(`wrote ${cases.length} cases → ${OUT}`)
