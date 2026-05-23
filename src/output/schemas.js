/**
 * Strict allowlist schemas for every MCP tool output. The SDK validates
 * `structuredContent` against the registered `outputSchema`, so a strict
 * schema doubles as a runtime guard: if the projection misses a field,
 * the SDK rejects the response before it reaches the client.
 *
 * Schemas declare ONLY the public allowlist — internal fields like
 * `matchQuality`, `tier`, `relaxed`, `partial`, `file_path` etc. are NOT
 * listed here and are stripped by `src/output/projection.js`.
 *
 * `APPLE_DOCS_DEBUG=1` flips every schema to `.passthrough()` so the
 * rich envelope passes validation under debug-mode passthrough. Use the
 * env var only for local debugging — production runs strict.
 */

import { z } from 'zod'

// Schemas declare ONLY allowlisted public fields. The runtime gate is
// the projection layer (src/output/projection.js), not zod — schemas
// here use `.passthrough()` so the MCP SDK's `tools/list` JSON-Schema
// conversion (which has trouble with `.strict()` in zod v4) works in
// both production and debug-passthrough modes. The leak-guard tests
// (test/mcp/leak-guard.test.js, test/unit/web-api-leak-guard.test.js,
// test/unit/cli-json-leak-guard.test.js) walk every response and reject
// any field outside the allowlist, so projection regressions still
// surface in CI.
function obj(shape) {
  return z.object(shape).passthrough()
}

// --- shared sub-schemas ------------------------------------------------------

const pageInfoSchema = obj({
  page: z.number().int().min(1).optional(),
  totalPages: z.number().int().min(1).optional(),
  hasNextPage: z.boolean().optional(),
  hasPreviousPage: z.boolean().optional(),
  totalItems: z.number().int().min(0).optional(),
}).optional()

// Platform info shape varies by source — DocC emits an object keyed by
// platform name (e.g. `{ ios: "13.0", ... }`), other sources emit an array
// of `{ name, introducedAt }`. Accept either; the public projection
// preserves whichever shape the command emits.
const platformsSchema = z
  .union([
    z.array(z.any()),
    z.record(z.string(), z.any()),
  ])
  .nullable()
  .optional()

const confidenceSchema = z.enum(['exact', 'partial', 'approximate'])

const searchHitSchema = obj({
  path: z.string().optional(),
  title: z.string().optional(),
  framework: z.string().nullable().optional(),
  rootSlug: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  sourceType: z.string().optional(),
  abstract: z.string().nullable().optional(),
  declaration: z.string().nullable().optional(),
  platforms: platformsSchema,
  language: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  relatedCount: z.number().int().min(0).optional(),
  confidence: confidenceSchema.optional(),
  isDeprecated: z.literal(true).optional(),
  isBeta: z.literal(true).optional(),
  isReleaseNotes: z.literal(true).optional(),
})

const relationshipsCountSchema = obj({
  inheritsFrom: z.number().int().min(0).optional(),
  inheritedBy: z.number().int().min(0).optional(),
  conformsTo: z.number().int().min(0).optional(),
  seeAlso: z.number().int().min(0).optional(),
  children: z.number().int().min(0).optional(),
}).optional()

const documentMetadataSchema = obj({
  title: z.string().optional(),
  framework: z.string().nullable().optional(),
  rootSlug: z.string().nullable().optional(),
  roleHeading: z.string().nullable().optional(),
  kind: z.string().nullable().optional(),
  abstract: z.string().nullable().optional(),
  declaration: z.string().nullable().optional(),
  path: z.string().optional(),
  platforms: platformsSchema,
  relationships: relationshipsCountSchema,
  isDeprecated: z.literal(true).optional(),
  isBeta: z.literal(true).optional(),
  isReleaseNotes: z.literal(true).optional(),
})

// Section can be a skeleton ({ heading, chars }) or full ({ heading,
// contentText }). Both are valid public shapes — match either.
const sectionSchema = obj({
  heading: z.string().nullable().optional(),
  chars: z.number().int().min(0).optional(),
  contentText: z.string().optional(),
})

// --- per-tool schemas --------------------------------------------------------

export const searchDocsOutputSchema = obj({
  // search variant
  query: z.string().optional(),
  total: z.number().int().min(0).optional(),
  results: z.array(searchHitSchema).optional(),
  approximate: z.literal(true).optional(),
  truncated: z.literal(true).optional(),
  pageInfo: pageInfoSchema,
  // read=true variant
  found: z.boolean().optional(),
  metadata: documentMetadataSchema.optional(),
  content: z.string().nullable().optional(),
  sections: z.array(sectionSchema).optional(),
  matches: z.array(z.any()).optional(),
  note: z.string().optional(),
  bestMatch: searchHitSchema.optional(),
})

export const readDocOutputSchema = obj({
  found: z.boolean(),
  metadata: documentMetadataSchema.optional(),
  content: z.string().nullable().optional(),
  sections: z.array(sectionSchema).optional(),
  matches: z.array(z.any()).optional(),
  note: z.string().optional(),
  bestMatch: searchHitSchema.optional(),
  pageInfo: pageInfoSchema,
})

export const listFrameworksOutputSchema = obj({
  roots: z.array(obj({
    slug: z.string(),
    name: z.string().optional(),
    kind: z.string().optional(),
    pageCount: z.number().int().min(0).optional(),
  })),
  total: z.number().int().min(0).optional(),
  pageInfo: pageInfoSchema,
})

export const browseOutputSchema = obj({
  framework: z.string().optional(),
  title: z.string().optional(),
  path: z.string().optional(),
  pages: z.array(obj({
    path: z.string(),
    title: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    abstract: z.string().nullable().optional(),
  })).optional(),
  children: z.array(obj({
    path: z.string(),
    title: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    section: z.string().nullable().optional(),
  })).optional(),
  total: z.number().int().min(0).optional(),
  pageInfo: pageInfoSchema,
})

const taxonomyEntrySchema = obj({
  value: z.string().nullable(),
  count: z.number().int().min(0),
})

export const listTaxonomyOutputSchema = obj({
  kind: z.array(taxonomyEntrySchema).optional(),
  role: z.array(taxonomyEntrySchema).optional(),
  docKind: z.array(taxonomyEntrySchema).optional(),
  roleHeading: z.array(taxonomyEntrySchema).optional(),
  sourceType: z.array(taxonomyEntrySchema).optional(),
})

const sfSymbolHitSchema = obj({
  name: z.string(),
  scope: z.string(),
})

export const searchSfSymbolsOutputSchema = obj({
  results: z.array(sfSymbolHitSchema),
})

const fontFileSchema = obj({
  id: z.string(),
  file_name: z.string(),
})

const fontFamilySchema = obj({
  id: z.string(),
  name: z.string().optional(),
  files: z.array(fontFileSchema),
})

export const listAppleFontsOutputSchema = obj({
  families: z.array(fontFamilySchema),
})

export const renderSfSymbolOutputSchema = obj({
  name: z.string(),
  scope: z.string(),
  format: z.enum(['svg', 'png']),
  resourceUri: z.string().optional(),
  svg: z.string().optional(),
})

export const renderFontTextOutputSchema = obj({
  text: z.string().optional(),
  mimeType: z.string().optional(),
  content: z.string().nullable().optional(),
})
