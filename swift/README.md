# AppleDocsCore (Swift)

The Swift-native side of `apple-docs`: a C-ABI dynamic library (`libAppleDocsCore`)
that the Bun/TypeScript CLI loads for hot paths, plus `ad-server` — an Apple-native
HTTP + MCP host that serves the same SQLite corpus in-process (no FFI).

Everything builds with the toolchain pinned in [`.swift-version`](.swift-version)
(currently `6.4`), under Swift 6 language mode with complete strict-concurrency
checking. The package floors at macOS 15 / Linux (Swift 6); only `ad-server` is
Apple-native — the dylib stays cross-platform.

## Module map

| Module | Role |
| --- | --- |
| `ADBase` | FFI result/request codecs (`ResultBuffer`, `RequestReader`, `BatchResult`), JSON (`Json` eager tree + `JsonTape` zero-copy tape), status/build-info. |
| `ADSearch` | Fusion (weighted RRF / hybrid) + MMR — scalar, bit-for-bit parity with the JS scorer. |
| `ADArchive` | tar + zstd writer/decoder (libzstd via `dlopen`). |
| `ADEmbed` | WordPiece tokenizer + embedder + generated Unicode tables (transformers.js parity). |
| `ADContent` | DocC content → Markdown / plain-text renderers (byte-parity with the JS renderers). |
| `ADRender` | SF Symbol / font → SVG/PNG/PDF (CoreText/CoreGraphics on Apple; HarfBuzz on Linux). |
| `CSQLiteShim` | Tiny C shim to call the variadic `sqlite3_config` with the correct ABI. |
| `ADStorage` | SQLite read layer (libsqlite3 via `dlopen`), connection pool + handle registry. |
| `ADSearchCascade` | The in-process lexical search cascade (server-only; the byte-exact JS port). |
| `ADCore` | `libAppleDocsCore` — the C-ABI dylib aggregating the engines. **Depends only on first-party modules + (per RFC) no third-party runtime deps.** |
| `ADServeCore` | The `ad-server` engine: NIO bootstrap, HTTP/1.1+HTTP/2, response envelope, connection pool, the MCP JSON-RPC core. |
| `ADServeDSL` | The route + MCP-tool result-builder DSL (`Server { App { GET(…) } }`). |
| `ad-server` | The executable (composition root) — subcommands `serve` / `mcp` / `bench`. |
| `ad-embed-dump` | Dev-only reference dump for the fixture generator (not shipped). |

## Build

```sh
cd swift
swift build                 # debug
swift build -c release      # release (cross-module optimization on)
AD_HTTP3=1 swift build       # opt-in QUIC/HTTP3 (raises the macOS floor to 26)
```

### Building against unpublished siblings

The first-party `g-cqd/AD*` dependencies (ADFoundation, ADJSON, ADHTML, ADServe, and
the dev-only ADBuildTools/ADTestKit) resolve from their published `main` branch by
default. (ADDB and ADSQL are no longer dependencies — the storage pivot, RFC 0007
D-0007-4, returned the corpus to real SQLite.) While they are unpublished, point the manifest at local checkouts via the
`*_PATH` env overrides (see the `Context.environment[...]` blocks in `Package.swift`).
The committed [`build.sh`](build.sh) wrapper does this for you — it exports every
`*_PATH` to sibling checkouts beside this repo, then execs `swift`:

```sh
./build.sh build -c release   # release dylib (what CI's `native` job builds)
./build.sh test               # full suite (auto-sets APPLEDOCS_DEV for ADTestKit)
AD_SIBLINGS_ROOT=/abs/path ./build.sh build -c release   # siblings located elsewhere
```

CI's swift jobs (`swift-format`, `swift-sanitizers`, `native`, and the snapshot
workflow's `build-native`) are gated behind the `AD_SWIFT_SIBLINGS_PUBLISHED` repo
variable and stay skipped until the siblings are published; flip it to `'true'` once
they are pushed.

The dylib is emitted as `.build/<config>/libAppleDocsCore.{dylib,so}`. Its ABI
contract (v0) is fixed; the `@_cdecl` exports never trap on input — a malformed
request surfaces as a status buffer, never an abort across the C boundary.

## `ad-server`

```sh
# HTTP server (default subcommand) — loopback plaintext, intended behind Caddy.
ad-server serve --db corpus.sqlite [--port 3032] [--threads N] [--loops 2] \
  [--tls-cert chain.pem --tls-key key.pem --tls-port 8443] \
  [--transport nio|network] [--base-url https://…] [--site-name …] [--app-version …]

# stdio MCP server (one serial client; logs to stderr, JSON-RPC on stdout).
ad-server mcp --db corpus.sqlite

# In-process read+JSON microbenchmark (no NIO/offload/HTTP).
ad-server bench --db corpus.sqlite 10000
```

Passing both `--tls-cert` and `--tls-key` adds an in-process TLS 1.3 listener
(HTTP/2 + HTTP/1.1 by ALPN) on `--tls-port`, alongside the plaintext loopback.

### Routes

`GET /healthz`, `GET /readyz`, `GET /search`, `GET /api/filters`, `GET /api/fonts`,
`GET /api/fonts/faces.css`, `GET /api/symbols/index.json`, `GET /api/symbols/search`,
`GET /data/search/*`, the discovery set (`/robots.txt`, `/opensearch.xml`,
`/.well-known/*`), and the MCP transport `POST /mcp` + `OPTIONS /mcp`.

## Tests & tooling

```sh
swift test                                  # the full suite (Swift Testing)
swift test --enable-code-coverage           # + coverage profdata
swift test --sanitize=address               # ASan (FFI / unsafe surface)
swift test --sanitize=thread --no-parallel  # TSan (concurrency)
swift format lint --strict --recursive Sources Tests   # formatting gate (.swift-format)
```

CI builds the dylib on every bridge target and proves JS↔Swift parity through a
staged artifact (the `native` job); a fusion/content/embed change must pass it too.
