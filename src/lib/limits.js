/**
 * Input bounds shared by the public web API and the MCP tools, so both
 * surfaces reject the same oversized or malformed values.
 */

/** Longest accepted search query, in UTF-16 code units. Real queries are a few words. */
export const MAX_SEARCH_QUERY_CHARS = 1024

/** Largest accepted `maxChars` page size for paginated MCP tools. Responses are capped lower server-side. */
export const MAX_PAGINATED_MAX_CHARS = 100_000

/** Highest accepted 1-based `page` for paginated MCP tools. */
export const MAX_PAGINATED_PAGE = 10_000

/** `/api/search` result window: default, hard cap on `limit`, and cap on `offset`. */
export const SEARCH_DEFAULT_LIMIT = 50
export const SEARCH_MAX_LIMIT = 200
export const SEARCH_MAX_OFFSET = 10_000
