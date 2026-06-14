// ADServeDSL — the endpoint DSL (RFC 0005): @RouteBuilder, Route/Group, the typed
// `Path` (RegexBuilder captures), RequestContext, RouteQuery, ResponseContent, and
// the .cache/.storage modifiers (the Tool DSL lands in Phase C). It sees only
// ADServeCore's public surface, so a route declaration cannot reach into engine
// internals. Phase A scaffold; the builders land in Phase B.

import ADServeCore

/// Namespace + scaffold marker for the endpoint DSL. Real builders land in Phase B.
public enum ADServeDSL {
  /// Tracks the engine scaffold it builds on (verifies the ADServeCore link).
  public static let scaffoldVersion = ADServeCore.scaffoldVersion
}
