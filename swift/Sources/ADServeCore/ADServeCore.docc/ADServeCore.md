# ``ADServeCore``

The `ad-server` engine — the optimizable serving layer the route DSL and the
business logic sit on top of.

## Overview

`ADServeCore` owns the value types a request/response flows through, the NIO
bootstrap and serving loop, the SQLite connection pool, the response envelope
(security headers, ETag/304, request-id), and the in-house Model Context
Protocol (MCP) JSON-RPC core. It knows nothing route-specific: routes are
declared with ``ADServeDSL`` and matched through the ``HTTPHandling`` contract.

Each listener speaks its ``Wire`` (plaintext HTTP/1.1, or TLS with HTTP/2 +
HTTP/1.1 by ALPN). One blocking handler per `.storage` request is offloaded to a
thread pool with a pooled ``StorageConnection`` checked out via a noncopyable
``ConnectionLease`` (returned on scope exit), so one connection is touched by one
thread at a time.

## Topics

### Server

- ``HTTPServer``
- ``ListenerConfig``
- ``ServerReadiness``
- ``EngineTransport``

### Wire & TLS

- ``Wire``
- ``ALPN``
- ``TLSSource``

### Connection pool

- ``ConnectionPool``
- ``ConnectionLease``

### Request & response

- ``ServerRequest``
- ``ResponseContent``
- ``MediaType``
- ``CachePolicy``

### Routing contract

- ``HTTPHandling``
- ``HandlerInput``
- ``MatchedRoute``
- ``RouteMatch``

### Model Context Protocol

- ``MCPDispatcher``
- ``MCPServerInfo``
- ``MCPToolDefinition``
- ``MCPToolContext``
- ``MCPToolResult``
- ``MCPToolProviding``
- ``StdioMCPTransport``

### HTTP helpers

- ``sha256HexLower(_:)``
- ``matchesIfNoneMatch(_:_:)``
- ``resolveRequestID(_:)``
