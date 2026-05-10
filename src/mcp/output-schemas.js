/**
 * Output schemas for every MCP tool (D.1).
 *
 * `server.registerTool({ outputSchema })` triggers SDK-side validation
 * of the tool's `structuredContent` against the schema. The schemas
 * here are deliberately permissive — `.passthrough()` on every object
 * so an internal projection change can't blow up the contract — but
 * each one declares the top-level fields a client can rely on. This
 * gives MCP clients a typed shape to discover via tools/list while
 * letting our projections evolve without a coordinated schema bump.
 *
 * Convention: every schema is a ZodObject (not a raw shape) so it can
 * carry `.passthrough()`. The SDK accepts both forms.
 */

import { z } from 'zod'

// A search hit projection. Fields shown match what `projectSearchHit`
// keeps after stripping (urlDepth, isReleaseNotes, score, sourceMetadata
// are dropped). Most fields are optional because hit shape varies by
// source-type (DocC vs WWDC vs sample-code vs guidelines).
const searchHitSchema = z
  .object({
    path: z.string().optional(),
    title: z.string().optional(),
    abstract: z.string().nullable().optional(),
    framework: z.string().nullable().optional(),
    sourceType: z.string().optional(),
    role: z.string().nullable().optional(),
    roleHeading: z.string().nullable().optional(),
    kind: z.string().nullable().optional(),
    language: z.string().nullable().optional(),
    isDeprecated: z.boolean().optional(),
    isBeta: z.boolean().optional(),
    matchQuality: z.string().optional(),
  })
  .passthrough()

const documentMetadataSchema = z.object({}).passthrough()

const sectionSchema = z.object({}).passthrough()

const sectionSkeletonSchema = z
  .object({
    heading: z.string().nullable(),
    chars: z.number(),
  })
  .passthrough()

// search_docs returns one of two shapes depending on `read`:
//   - normal:    { results, tier, query, ... }
//   - read=true: { found, metadata, content, sections, bestMatch, ... }
// Declare a single permissive object covering both. Fields are all
// optional; .passthrough() lets pageInfo / paginated sub-fields survive.
export const searchDocsOutputSchema = z
  .object({
    results: z.array(searchHitSchema).optional(),
    tier: z.string().optional(),
    query: z.string().optional(),
    relaxed: z.boolean().optional(),
    relaxationTier: z.string().optional(),
    found: z.boolean().optional(),
    metadata: documentMetadataSchema.optional(),
    content: z.string().nullable().optional(),
    sections: z.array(z.union([sectionSchema, sectionSkeletonSchema])).optional(),
    bestMatch: searchHitSchema.optional(),
    note: z.string().optional(),
    pageInfo: z.object({}).passthrough().optional(),
  })
  .passthrough()

export const readDocOutputSchema = z
  .object({
    found: z.boolean(),
    metadata: documentMetadataSchema.optional(),
    content: z.string().nullable().optional(),
    sections: z.array(z.union([sectionSchema, sectionSkeletonSchema])).optional(),
    note: z.string().optional(),
    bestMatch: searchHitSchema.optional(),
    pageInfo: z.object({}).passthrough().optional(),
  })
  .passthrough()

export const listFrameworksOutputSchema = z
  .object({
    roots: z.array(
      z
        .object({
          slug: z.string(),
          title: z.string().optional(),
          displayName: z.string().optional(),
          kind: z.string().optional(),
          sourceType: z.string().optional(),
          pageCount: z.number().optional(),
        })
        .passthrough(),
    ),
    pageInfo: z.object({}).passthrough().optional(),
  })
  .passthrough()

// browse returns either a framework listing { pages: [...] } or a
// single-page drill-in { children: [...], references: [...] }. Both
// shapes coexist in one schema with optional arrays.
export const browseOutputSchema = z
  .object({
    framework: z.string().optional(),
    pages: z.array(z.object({}).passthrough()).optional(),
    children: z.array(z.object({}).passthrough()).optional(),
    references: z.array(z.object({}).passthrough()).optional(),
    page: z.object({}).passthrough().optional(),
    pageInfo: z.object({}).passthrough().optional(),
  })
  .passthrough()

// list_taxonomy emits a record-shaped response (kind/role/docKind/
// roleHeading/sourceType → array of { value, count }). Per-field
// optional so the targeted-field variant (`field: 'kind'`) validates
// against the same schema.
const taxonomyEntrySchema = z
  .object({
    value: z.string().nullable(),
    count: z.number(),
  })
  .passthrough()

export const listTaxonomyOutputSchema = z
  .object({
    kind: z.array(taxonomyEntrySchema).optional(),
    role: z.array(taxonomyEntrySchema).optional(),
    docKind: z.array(taxonomyEntrySchema).optional(),
    roleHeading: z.array(taxonomyEntrySchema).optional(),
    sourceType: z.array(taxonomyEntrySchema).optional(),
  })
  .passthrough()

// Asset tools.

const sfSymbolHitSchema = z
  .object({
    name: z.string(),
    scope: z.string(),
  })
  .passthrough()

export const searchSfSymbolsOutputSchema = z
  .object({
    results: z.array(sfSymbolHitSchema),
  })
  .passthrough()

const fontFileSchema = z
  .object({
    id: z.string(),
    file_name: z.string(),
  })
  .passthrough()

const fontFamilySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    files: z.array(fontFileSchema),
  })
  .passthrough()

// listAppleFonts returns the bare array — no envelope. structuredContent
// has to be an object per JSON-RPC, so the assets tool wraps it. The
// current implementation passes the array directly to createMcpTextResult,
// so the structuredContent IS an array. Newer SDKs reject array roots —
// declare it as an object whose `families` key holds the array; tools will
// be aligned with this schema in the wrapper below.
export const listAppleFontsOutputSchema = z
  .object({
    families: z.array(fontFamilySchema),
  })
  .passthrough()

export const renderSfSymbolOutputSchema = z
  .object({
    name: z.string(),
    scope: z.string(),
    format: z.enum(['svg', 'png']),
    file_path: z.string().optional(),
    resourceUri: z.string().optional(),
    svg: z.string().optional(),
  })
  .passthrough()

export const renderFontTextOutputSchema = z
  .object({
    text: z.string().optional(),
    format: z.string().optional(),
    mimeType: z.string().optional(),
    content: z.string().nullable().optional(),
    font: z.object({}).passthrough().optional(),
  })
  .passthrough()
