# AppleDocsCore (Swift)

The Swift-native side of `apple-docs`: a C-ABI dynamic library (`libAppleDocsCore`)
that the Bun/TypeScript CLI loads for hot paths, plus `ad-server` — an Apple-native
HTTP + MCP host that serves the same SQLite corpus in-process (no FFI).

Everything builds with the toolchain pinned in [`.swift-version`](.swift-version)
(currently `6.3.2`), under Swift 6 language mode with complete strict-concurrency
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
