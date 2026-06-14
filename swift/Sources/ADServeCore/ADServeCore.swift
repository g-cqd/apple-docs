// ADServeCore — the ad-server ENGINE layer (RFC 0005). The optimizable server:
// NIO bootstrap, HTTP/1.1 on swift-http-types, the response envelope + middleware,
// the `.storage` offload executor, swift-log, and (Phase C+) the MCP JSON-RPC core
// + stdio/Streamable-HTTP transports. Decoupled from any specific route — it knows
// nothing route-specific. Phase A scaffold; the engine lands in Phase B.

/// Namespace + scaffold marker for the server engine. Real types land in Phase B.
public enum ADServeCore {
  /// Bumped as the engine's public surface stabilizes (Phase B+).
  public static let scaffoldVersion = 0
}
