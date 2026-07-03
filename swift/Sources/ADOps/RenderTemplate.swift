// Render an ops template (.tpl) by substituting only an explicit allowlist of
// variables — the native port of ops/lib/render-template.js.
//
// Why an allowlist instead of a blanket `envsubst`: the templates legitimately
// contain `${SOMETHING}` strings that are NOT meant to be substituted (shell
// parameter expansions embedded in a launchd plist's ProgramArguments, etc.).
// An allowlist makes rendering explicit — anything not on the list passes
// through untouched; anything on the list must be present + non-empty in the
// env, or the placeholder is reported `unresolved` and ALSO passes through
// literally (matching the JS: an allowlisted-but-empty var stays `${VAR}`).
//
// Scanning is done on raw UTF-8 bytes so the output is byte-identical to the JS
// `String.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, …)`: the placeholder syntax
// is pure ASCII, and every other byte (including multi-byte UTF-8 in comments)
// is copied through verbatim.

/// The outcome of rendering a template: the rendered bytes plus the de-duplicated
/// (insertion-ordered) lists of placeholders that were referenced-but-unset
/// (`unresolved`) or not on the allowlist (`ignored`).
public struct RenderResult: Sendable, Equatable {
    /// The rendered content, as UTF-8 bytes (byte-exact with the JS output).
    public let contentBytes: [UInt8]
    /// Allowlisted keys referenced by the template but absent/empty in `env`.
    /// The placeholder text is preserved verbatim in `contentBytes` for these.
    public let unresolved: [String]
    /// Keys referenced by the template that are NOT on the allowlist. Passed
    /// through verbatim.
    public let ignored: [String]

    public init(contentBytes: [UInt8], unresolved: [String], ignored: [String]) {
        self.contentBytes = contentBytes
        self.unresolved = unresolved
        self.ignored = ignored
    }

    /// The rendered content decoded as a Swift `String` (UTF-8). Prefer
    /// `contentBytes` when byte-fidelity matters (String `==` is canonical, not
    /// byte, equivalence).
    public var content: String { String(decoding: contentBytes, as: UTF8.self) }
}

/// The canonical allowlist, mirroring ops/lib/render.sh's ALLOWED_VARS and
/// ops/lib/render-template.js's `ALLOWED_VARS`. Order is preserved from the JS.
public let allowedVars: [String] = [
    "USER_NAME", "REPO_DIR", "OPS_DIR", "DATA_DIR", "BUN_BIN", "STATIC_DIR",
    "LABEL_PREFIX", "LABEL_PROXY", "LABEL_WEB", "LABEL_MCP",
    "LABEL_TUNNEL_WEB", "LABEL_TUNNEL_MCP", "LABEL_WATCHDOG",
    "LABEL_AUTOROLL", "AUTOROLL_WEEKDAY", "AUTOROLL_HOUR",
    "WEB_PORT", "MCP_PORT", "WEB_BACKEND_PORT", "MCP_BACKEND_PORT",
    "PUBLIC_WEB_HOST", "PUBLIC_MCP_HOST", "CADDY_ADMIN_ADDR",
    "TUNNEL_NAME_WEB", "TUNNEL_NAME_MCP",
    "CLOUDFLARED_CREDENTIALS_FILE_WEB", "CLOUDFLARED_CREDENTIALS_FILE_MCP",
    "CLOUDFLARED_BIN", "APPLE_DOCS_MCP_CACHE_SCALE", "APPLE_DOCS_NATIVE"
]

/// The allowlist as a `Set` for O(1) membership. Same contents as `allowedVars`.
public let allowedVarsSet: Set<String> = Set(allowedVars)

public enum RenderTemplate {
    /// Render a template's UTF-8 bytes, substituting only the allowlisted
    /// placeholders. Never throws — a malformed or dangling `${` is copied
    /// through untouched (the JS regex would not match it either).
    public static func render(
        bytes template: [UInt8],
        env: [String: String],
        allowed: Set<String> = allowedVarsSet
    ) -> RenderResult {
        var accumulator = RenderAccumulator(capacity: template.count)
        let n = template.count
        var i = 0
        while i < n {
            // A placeholder is `$` `{` IDENT `}` where IDENT is
            // [A-Za-z_][A-Za-z0-9_]* — mirrors PLACEHOLDER_RE exactly.
            if template[i] == asciiDollar, i + 1 < n, template[i + 1] == asciiLBrace {
                var j = i + 2
                if j < n, isIdentStart(template[j]) {
                    j += 1
                    while j < n, isIdentCont(template[j]) { j += 1 }
                    if j < n, template[j] == asciiRBrace {
                        let key = String(decoding: template[(i + 2) ..< j], as: UTF8.self)
                        accumulator.emit(
                            key: key, placeholder: template[i ... j], env: env, allowed: allowed)
                        i = j + 1
                        continue
                    }
                }
            }
            accumulator.out.append(template[i])
            i += 1
        }
        return accumulator.result()
    }

    /// Convenience overload taking the template as a `String`.
    public static func render(
        _ template: String,
        env: [String: String],
        allowed: Set<String> = allowedVarsSet
    ) -> RenderResult {
        render(bytes: Array(template.utf8), env: env, allowed: allowed)
    }
}

/// The rendering accumulator: the output bytes plus the de-duplicated (ordered)
/// `unresolved` / `ignored` lists.
private struct RenderAccumulator {
    var out: [UInt8] = []
    private var unresolved: [String] = []
    private var unresolvedSeen: Set<String> = []
    private var ignored: [String] = []
    private var ignoredSeen: Set<String> = []

    init(capacity: Int) { out.reserveCapacity(capacity) }

    /// Emit one resolved placeholder: not-allowlisted → `ignored` + verbatim;
    /// allowlisted-but-empty → `unresolved` + verbatim; else the env value.
    mutating func emit(
        key: String, placeholder: ArraySlice<UInt8>, env: [String: String], allowed: Set<String>
    ) {
        if !allowed.contains(key) {
            if ignoredSeen.insert(key).inserted { ignored.append(key) }
            out.append(contentsOf: placeholder)
            return
        }
        if let value = env[key], !value.isEmpty {
            out.append(contentsOf: value.utf8)
            return
        }
        if unresolvedSeen.insert(key).inserted { unresolved.append(key) }
        out.append(contentsOf: placeholder)
    }

    func result() -> RenderResult {
        RenderResult(contentBytes: out, unresolved: unresolved, ignored: ignored)
    }
}

// MARK: - byte helpers

private let asciiDollar: UInt8 = 0x24  // $
private let asciiLBrace: UInt8 = 0x7B  // {
private let asciiRBrace: UInt8 = 0x7D  // }
private let asciiUnderscore: UInt8 = 0x5F  // _

/// `[A-Za-z_]` — the first identifier byte.
private func isIdentStart(_ byte: UInt8) -> Bool {
    (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A) || byte == asciiUnderscore
}

/// `[A-Za-z0-9_]` — a continuation identifier byte.
private func isIdentCont(_ byte: UInt8) -> Bool {
    isIdentStart(byte) || (byte >= 0x30 && byte <= 0x39)
}
