# Phase 3: MCP SDK Migration

> **Goal**: Replace the hand-rolled JSON-RPC MCP server with the official TypeScript MCP SDK, gaining typed tools, transport evolution, resources, and community compatibility.

## Why Official SDK

The current `src/mcp/server.js` is a custom line-buffered JSON-RPC implementation. It works, but:

- **No typed tools** — tool schemas are hand-maintained JSON
- **No resources** — can't expose `apple-docs://doc/{path}` resource URIs
- **No transport evolution** — stuck on stdio; can't add HTTP/SSE without reimplementing
- **No contract tests** — protocol correctness is manually verified
- **Maintenance burden** — every MCP spec change requires manual updates

The official `@anthropic-ai/sdk` (or `@modelcontextprotocol/sdk`) provides all of this out of the box.

**Important**: This phase can run in parallel with Phase 2 (Source Adapters) because they touch disjoint code — MCP touches the protocol/tool layer while adapters touch the pipeline/storage layer.

## Exception to Zero-Dependency Rule

The MCP SDK is the **one sanctioned dependency**. Rationale:
- MCP is a protocol standard — implementing it from scratch is like writing your own HTTP server
- The SDK handles transport negotiation, schema validation, and spec compliance
- It's maintained by the MCP spec authors and evolves with the protocol
- Without it, apple-docs is permanently behind on MCP features

If the team decides to stay zero-dependency, the alternative is to harden the custom server (add schema validation, contract tests, typed tool definitions) without the SDK. This plan assumes SDK adoption.

## Exit Criteria

- [ ] Official MCP SDK installed and integrated
- [ ] All 5 existing tools (search, read, list_frameworks, browse, status) ported
- [ ] Tool input schemas defined with Zod or JSON Schema
- [ ] MCP resources exposed: `apple-docs://doc/{key}`, `apple-docs://framework/{slug}`
- [ ] Contract tests verify tool inputs/outputs match MCP spec
- [ ] `apple-docs mcp start` launches the new server
- [ ] `apple-docs-mcp` binary shim still works (backward compatibility)
- [ ] Stdio transport works correctly with Claude, Cursor, and other MCP clients

## Tasks

### 3.1 — Install MCP SDK

**Files to modify**: `package.json`

```bash
bun add @modelcontextprotocol/sdk
```

This is the only npm dependency apple-docs will have. Document the rationale in a code comment at the import site.

### 3.2 — Define Tool Schemas

**File to create**: `src/mcp/schemas.js`

Define typed schemas for all tools:

```js
export const searchToolSchema = {
  name: 'search_docs',
  description: 'Search Apple developer documentation, HIG, guidelines, and all indexed sources',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      framework: { type: 'string', description: 'Filter by framework slug' },
      source: { type: 'string', description: 'Filter by source type', enum: ['apple-docc', 'hig', 'guidelines', ...] },
      kind: { type: 'string', description: 'Filter by document kind' },
      language: { type: 'string', description: 'Filter by language', enum: ['swift', 'objc'] },
      limit: { type: 'number', description: 'Max results', default: 10 },
      read: { type: 'boolean', description: 'Include full content of first result', default: false }
    },
    required: ['query']
  }
};

export const readToolSchema = {
  name: 'read_doc',
  description: 'Read a specific documentation page by path or symbol name',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Document path (e.g., documentation/swiftui/view)' },
      symbol: { type: 'string', description: 'Symbol name for fuzzy lookup' },
      framework: { type: 'string', description: 'Framework to disambiguate symbol' },
      format: { type: 'string', description: 'Output format', enum: ['markdown', 'html', 'text'], default: 'markdown' }
    }
  }
};

// ... list_frameworks, browse, status, search_wwdc (future), search_samples (future)
```

### 3.3 — Implement New MCP Server

**File to create**: `src/mcp/server-sdk.js`
**File to deprecate**: `src/mcp/server.js` (keep for reference during migration)

```js
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { searchToolSchema, readToolSchema, ... } from './schemas.js';
import { handleSearch, handleRead, ... } from './handlers.js';

export async function createMcpServer(ctx) {
  const server = new Server({
    name: 'apple-docs',
    version: '2.0.0',
  }, {
    capabilities: {
      tools: {},
      resources: {},
    }
  });

  // Register tools
  server.setRequestHandler('tools/list', async () => ({
    tools: [searchToolSchema, readToolSchema, listFrameworksSchema, browseSchema, statusSchema]
  }));

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
      case 'search_docs': return handleSearch(args, ctx);
      case 'read_doc': return handleRead(args, ctx);
      case 'list_frameworks': return handleListFrameworks(args, ctx);
      case 'browse': return handleBrowse(args, ctx);
      case 'status': return handleStatus(args, ctx);
      default: throw new Error(`Unknown tool: ${name}`);
    }
  });

  // Register resources
  server.setRequestHandler('resources/list', async () => ({
    resources: [
      { uri: 'apple-docs://status', name: 'Corpus Status', description: 'Current corpus health and statistics' }
    ],
    resourceTemplates: [
      { uriTemplate: 'apple-docs://doc/{key}', name: 'Documentation Page', description: 'Read a specific documentation page' },
      { uriTemplate: 'apple-docs://framework/{slug}', name: 'Framework', description: 'Browse a framework\'s topic tree' }
    ]
  }));

  server.setRequestHandler('resources/read', async (request) => {
    const { uri } = request.params;
    // Parse URI and dispatch to handlers
  });

  return server;
}

export async function startMcpServer() {
  const ctx = await createContext();
  const server = await createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

### 3.4 — Refactor Tool Handlers

**File to create**: `src/mcp/handlers.js`
**File to reference**: `src/mcp/tools.js` (existing tool dispatch logic)

Extract tool handling into pure functions that both MCP and CLI can call:

```js
export async function handleSearch(args, ctx) {
  const results = await search(ctx, args);
  return {
    content: [{ type: 'text', text: formatSearchResults(results) }]
  };
}

export async function handleRead(args, ctx) {
  const doc = await lookup(ctx, args);
  return {
    content: [{ type: 'text', text: doc.content }]
  };
}
```

This also deduplicates the formatting logic currently split between CLI and MCP.

### 3.5 — Update Entry Points

**Files to modify**: `index.js`, `src/cli/mcp-entry.js`, `cli.js`

- `index.js`: Import and call `startMcpServer()` from new `server-sdk.js`
- `src/cli/mcp-entry.js`: Same — delegates to `startMcpServer()`
- `cli.js`: `mcp start` command calls `startMcpServer()`

### 3.6 — Add Contract Tests

**File to create**: `test/mcp/contract.test.js`

Test MCP protocol compliance:
1. `initialize` handshake returns correct capabilities
2. `tools/list` returns all tool schemas
3. Each tool: valid input → expected output shape
4. Each tool: invalid input → proper error response
5. `resources/list` returns resource templates
6. `resources/read` with valid URI returns content
7. `resources/read` with invalid URI returns error

### 3.7 — Remove Old MCP Server

**Files to delete** (after migration verified): `src/mcp/server.js`, `src/mcp/tools.js`

Only after:
- All contract tests pass
- Manual testing with Claude Desktop, Cursor, and at least one other MCP client
- `apple-docs-mcp` backward compatibility verified

## Tool Mapping (Old → New)

| Old Tool Name | New Tool Name | Changes |
|---|---|---|
| `search` | `search_docs` | Add `source`, `language` filters |
| `read` | `read_doc` | Add `format` param (markdown/html/text) |
| `list_frameworks` | `list_frameworks` | Add `source` filter |
| `browse` | `browse` | No change |
| `status` | `status` | Add per-source breakdown |

## Future Tools (Added in Phase 4-5)

| Tool | Phase | Description |
|---|---|---|
| `search_wwdc` | 4 | Search WWDC transcripts by year, track, topic |
| `search_samples` | 4 | Search sample code projects |
| `read_sample_file` | 4 | Read a specific file from a sample project |
| `get_related` | 5 | Get related documents for a given page |
| `get_availability` | 5 | Check platform availability for a symbol |

## Files Changed Summary

| File | Action |
|---|---|
| `package.json` | Modify (add MCP SDK dependency) |
| `src/mcp/schemas.js` | Create |
| `src/mcp/server-sdk.js` | Create |
| `src/mcp/handlers.js` | Create |
| `index.js` | Modify (import new server) |
| `src/cli/mcp-entry.js` | Modify (import new server) |
| `cli.js` | Modify (mcp start dispatch) |
| `src/mcp/server.js` | Delete (after migration) |
| `src/mcp/tools.js` | Delete (after migration) |
| `test/mcp/contract.test.js` | Create |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| MCP SDK is the first npm dependency, breaking zero-dep principle | Certain | Low | Sanctioned exception; well-documented rationale |
| SDK version conflicts with Bun | Low | High | Test on current Bun version; pin SDK version |
| Existing MCP client configs break | Medium | High | `apple-docs-mcp` shim preserved; tool names mapped |
| SDK adds startup latency | Low | Low | Measure; SDK is lightweight |
