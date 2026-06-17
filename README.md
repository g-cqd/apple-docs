# apple-docs

**All of Apple's developer documentation, on your machine.** Search it from
the terminal, browse it in your browser, and plug it into Claude, Codex,
Cursor, or any other MCP client — fully offline once installed.

One indexed corpus (~353,000 documents), three ways in:

- **CLI** — `apple-docs search "NavigationStack"` answers in milliseconds.
- **MCP server** — your AI assistant cites real Apple docs instead of guessing.
- **Local website** — browse and full-text search in the browser, or publish
  it as a static site.

It covers Apple's API reference (DocC), Human Interface Guidelines, App Store
Review Guidelines, Swift Evolution, the Swift book, Swift.org, WWDC sessions
(1997–2026, transcripts included), Apple sample code, archived documentation,
a Swift package catalog, every SF Symbol, and Apple's fonts.

## Quick start

You need [Bun](https://bun.sh) 1.1+.

```bash
git clone https://github.com/g-cqd/apple-docs.git
cd apple-docs
bun run dev:setup    # install dependencies + link the CLI
apple-docs setup     # download + install the latest snapshot
```

`setup` downloads one verified archive (**1.89 GB**) and installs it in a few
minutes. After that, everything works offline:

```bash
apple-docs search "NavigationStack"
apple-docs search "how do I record audio in the background"
apple-docs read swiftui/view
```

Search takes both forms: exact symbol names and plain-English questions
(a local semantic index is built during setup — no cloud, no API key).

### Pick a disk/speed tradeoff (optional)

`setup` asks which storage profile you want; flags skip the prompt:

| | Command | Disk | Best for |
| --- | --- | --- | --- |
| Smallest | `apple-docs setup --compact` | ~4.6 GB | laptops, CI |
| Default | `apple-docs setup` | ~7.1 GB | most setups |
| Fastest reads | `apple-docs setup --prebuilt` | ~10.5 GB | serving the website |

All three contain the full corpus and search identically — they only trade
disk for read speed. Details and how to switch later:
[`docs/configuration.md`](docs/configuration.md#storage-profiles).

> Prefer a standalone binary or a production self-host? See
> [`docs/installing.md`](docs/installing.md).

## Everyday commands

```bash
# Search — filters beat clever queries
apple-docs search "Swift Testing" --source wwdc --year 2024
apple-docs search "privacy" --framework app-store-review
apple-docs search "scroll" --kind article --platform visionos

# Read a page (or just one section of it)
apple-docs read swiftui/view
apple-docs read View --framework swiftui
apple-docs read swiftui/view --section Overview

# Explore
apple-docs frameworks                  # every documentation root
apple-docs browse swiftui              # a framework's pages
apple-docs browse wwdc                 # WWDC years with session counts
apple-docs browse wwdc --year 2025     # one year's sessions
apple-docs status                      # corpus freshness + counts
```

`apple-docs --help` and `apple-docs <command> --help` are the exhaustive
reference.

## Use it from your AI tools (MCP)

```bash
apple-docs mcp install            # prints ready-to-paste client config
apple-docs mcp start              # stdio server
apple-docs mcp serve --port 3031  # Streamable HTTP server
```

Nine read-only tools: `search_docs`, `read_doc`, `list_frameworks`, `browse`,
`list_taxonomy`, `search_sf_symbols`, `list_apple_fonts`, `render_sf_symbol`,
`render_font_text` — plus resources for docs, frameworks, SF Symbol renders,
and font files.

The tool surface is deliberately **context-cheap**: definitions cost ~2.2k
tokens total (about a quarter of a typical multi-tool MCP server), responses
are compact JSON with pagination built in, and a CI budget test keeps it that
way. Your context window stays available for actual work.

HTTP mode has no built-in auth — keep it on loopback unless a reverse proxy
or tunnel handles access control.

### Public instance

A best-effort public deployment (no uptime SLA; self-host for production):

```bash
claude mcp add -s user --transport http apple-docs https://apple-docs-mcp.everest.mt/mcp
codex mcp add apple-docs -- bunx mcp-remote https://apple-docs-mcp.everest.mt/mcp
```

## Local website

```bash
apple-docs web serve                  # http://127.0.0.1:3000
apple-docs web build --out dist/web   # static site
```

The server is agent-friendly out of the box: append `.md` to any doc URL for
Markdown (`/docs/swiftui/view.md`), and discovery endpoints are served at
`/robots.txt`, `/.well-known/api-catalog` (RFC 9727), and
`/.well-known/mcp/server-card.json`. Deployment recipes:
`apple-docs web deploy <github-pages|cloudflare|vercel|netlify>` and
[`docs/self-hosting.md`](docs/self-hosting.md).

## Keeping it fresh

Snapshots are rebuilt weekly by CI. To update, re-run:

```bash
apple-docs setup --force
```

Running a newer macOS than CI? `apple-docs setup --beta --force` opts into
prerelease snapshots built on developer machines, which carry SF Symbols the
stable CI builds can't produce yet
([details](docs/configuration.md#beta-channel)).

Or skip snapshots entirely and crawl Apple's docs yourself:

```bash
apple-docs sync          # resumable, idempotent refresh
apple-docs sync --full   # clean rebuild
```

`sync` also merges Xcode's offline documentation asset when one is available
locally (USRs and a few thousand pages the public crawl can't see) — CI does
this for every published snapshot, so installed snapshots already include it.

Build your own portable snapshot with `apple-docs snapshot build --out dist`,
install it with `apple-docs setup --archive <path>`.

### Scoping the corpus (optional)

The full corpus is ~4.6–10.5 GB on disk depending on the storage profile.
If you only need a slice of it, drop a
`scope.json` into your data directory (default `~/.apple-docs`) saying what
to **keep**:

```json
{
  "version": 1,
  "sources": ["apple-docc", "hig", "swift-book"],
  "appleDoccFrameworks": ["swiftui", "combine"],
  "keepFonts": true,
  "keepSymbols": false
}
```

Every field is optional except `version` — omit `sources` to keep all
sources, omit `appleDoccFrameworks` to keep every framework. Then:

```bash
apple-docs prune --dry-run   # preview what would be removed
apple-docs prune             # trim the existing corpus, reclaim disk
```

`prune` deletes the out-of-scope pages (search indexes, semantic vectors,
and on-disk files included) without re-crawling anything, and future
`apple-docs sync` runs read the same file so the corpus stays scoped.
Delete `scope.json` and `sync` to grow back to full coverage. No
`scope.json` means nothing changes — full coverage is the default.

## What's in the corpus

| Source | Coverage |
| --- | --- |
| `apple-docc` | API reference: frameworks, technologies, release notes |
| `hig` | Human Interface Guidelines |
| `guidelines` | App Store Review Guidelines |
| `swift-evolution` | Swift Evolution proposals |
| `swift-book` | The Swift Programming Language |
| `swift-docc` | Swift toolchain docs (compiler, SwiftPM, migration guides) |
| `swift-org` | Swift.org documentation and articles |
| `apple-archive` | Archived Apple developer documentation |
| `wwdc` | WWDC sessions with transcripts, browsable by year |
| `sample-code` | Apple sample code catalog |
| `packages` | Swift package catalog with README content |

## Development

```bash
bun run ci                          # lint + typecheck + tests
bun run audit                       # + unused code, duplication, coverage
bun scripts/verify-profiles.mjs     # full integration matrix: installs every
                                    # storage profile from the latest snapshot
                                    # and exercises CLI + web + MCP against each
```

### Native (Swift) stack

Hot paths are also implemented in Swift as a C-ABI library (`libAppleDocsCore`)
the CLI loads at runtime, plus `ad-server` — an Apple-native HTTP + MCP host that
serves the corpus in-process. Build it with `cd swift && swift build`; run the
server with `ad-server serve --db <corpus.sqlite>` or the stdio MCP transport with
`ad-server mcp --db <corpus.sqlite>`. See [`swift/README.md`](swift/README.md) for
the module map, build flags, and the `ad-server` reference.

More docs: [architecture](docs/architecture.md) ·
[configuration](docs/configuration.md) · [installing](docs/installing.md) ·
[self-hosting](docs/self-hosting.md) · [performance](docs/perf/index.md) ·
[security](docs/security.md) · [index](docs/README.md)

## License

[MIT](LICENSE).
