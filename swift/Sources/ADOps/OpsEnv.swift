// Load ops/.env as KEY=VALUE data (no `source`, no eval) — the native port of
// ops/lib/env.js.
//
// Why the security song-and-dance: ops/.env carries Cloudflare API tokens and
// the launchctl-privileged label prefix. Sourcing it as bash would let anything
// writable by another user embed `$(rm -rf /)` and run as the ops owner. This
// mirrors env.js exactly (mode 0600, owner check, identifier allowlist, quote
// stripping) with every check injectable through `Deps` so tests can exercise
// the failure paths without `chmod`'ing real files.

private import Foundation

/// The variables that MUST appear (non-empty) in ops/.env.
public let requiredVars: [String] = [
    "USER_NAME", "REPO_DIR", "OPS_DIR", "DATA_DIR", "BUN_BIN", "LABEL_PREFIX",
    "WEB_PORT", "MCP_PORT", "WEB_BACKEND_PORT", "MCP_BACKEND_PORT",
    "PUBLIC_WEB_HOST", "PUBLIC_MCP_HOST", "CADDY_ADMIN_ADDR",
    "TUNNEL_NAME_WEB", "TUNNEL_NAME_MCP",
    "CLOUDFLARED_CREDENTIALS_FILE_WEB", "CLOUDFLARED_CREDENTIALS_FILE_MCP",
    "CLOUDFLARED_BIN"
]

/// Names the loader derives from the parsed file (never required in .env).
public let derivedNames: [String] = [
    "LABEL_PROXY", "LABEL_WEB", "LABEL_MCP",
    "LABEL_TUNNEL_WEB", "LABEL_TUNNEL_MCP", "LABEL_WATCHDOG", "LABEL_AUTOROLL",
    "AUTOROLL_WEEKDAY", "AUTOROLL_HOUR",
    "STATIC_DIR", "APPLE_DOCS_MCP_CACHE_SCALE", "APPLE_DOCS_NATIVE", "LEGACY_LAUNCHD_LABELS",
    "SNAPSHOT_CHANNEL"
]

/// The failure reason for a rejected .env. `exitCode` mirrors the bash version's
/// sysexits EX_CONFIG (78).
public struct EnvLoadError: Error, Equatable, Sendable {
    public enum Code: String, Sendable {
        case missing
        case wrongOwner = "wrong-owner"
        case wrongMode = "wrong-mode"
        case missingRequired = "missing-required"
        case badChannel = "bad-channel"
    }
    public let message: String
    public let code: Code
    public let exitCode: Int32

    public init(message: String, code: Code, exitCode: Int32 = 78) {
        self.message = message
        self.code = code
        self.exitCode = exitCode
    }
}

/// The launchd labels derived from `LABEL_PREFIX`.
public struct OpsLabels: Sendable, Equatable {
    public let proxy: String
    public let web: String
    public let mcp: String
    public let tunnelWeb: String
    public let tunnelMcp: String
    public let watchdog: String
    public let autoroll: String
}

/// A fully loaded + validated ops environment.
public struct LoadedEnv: Sendable, Equatable {
    public let vars: [String: String]
    public let labels: OpsLabels
    public let staticDir: String
    public let opsDir: String
    public let repoDir: String
    public let dataDir: String
    public let bunBin: String
}

public enum OpsEnv {
    /// Stat facts the owner/mode checks need. `mode` carries the POSIX
    /// permission bits (the mode check masks with `& 0o777`); `uid` the owner.
    public struct FileFacts: Sendable, Equatable {
        public let mode: UInt32
        public let uid: UInt32
        public init(mode: UInt32, uid: UInt32) {
            self.mode = mode
            self.uid = uid
        }
    }

    /// Injectable seams for `load`. Defaults hit the real filesystem + POSIX ids.
    public struct Deps: Sendable {
        public var readFile: @Sendable (String) throws -> String
        public var stat: @Sendable (String) throws -> FileFacts
        public var currentUid: @Sendable () -> UInt32
        public var currentUser: @Sendable () -> String
        public var sudoUid: @Sendable () -> String?

        public init(
            readFile: @escaping @Sendable (String) throws -> String = OpsEnv.defaultRead,
            stat: @escaping @Sendable (String) throws -> FileFacts = OpsEnv.defaultStat,
            currentUid: @escaping @Sendable () -> UInt32 = OpsEnv.defaultCurrentUid,
            currentUser: @escaping @Sendable () -> String = OpsEnv.defaultCurrentUser,
            sudoUid: @escaping @Sendable () -> String? = OpsEnv.defaultSudoUid
        ) {
            self.readFile = readFile
            self.stat = stat
            self.currentUid = currentUid
            self.currentUser = currentUser
            self.sudoUid = sudoUid
        }
    }

    /// Load + validate ops/.env and return the derived `LoadedEnv`, throwing
    /// `EnvLoadError` on any policy failure (missing file, wrong owner, wrong
    /// mode, missing-required, bad channel). `opsDir` is the ops root
    /// (`<opsDir>/.env` is the default path); `path` overrides it; and
    /// `skipOwnerCheck`/`skipModeCheck` are the test-only escape hatches.
    public static func load(
        opsDir: String,
        path: String? = nil,
        skipOwnerCheck: Bool = false,
        skipModeCheck: Bool = false,
        deps: Deps = Deps()
    ) throws -> LoadedEnv {
        let envPath = path ?? joinPath(opsDir, ".env")

        let facts: FileFacts
        do {
            facts = try deps.stat(envPath)
        } catch {
            throw EnvLoadError(
                message: "\(envPath) not found. Copy ops/.env.example to ops/.env and edit it.",
                code: .missing)
        }

        let cuid = deps.currentUid()
        var acceptable: Set<UInt32> = [cuid]
        if cuid == 0, let sudo = deps.sudoUid(), let n = UInt32(sudo) {
            acceptable.insert(n)
        }
        if !skipOwnerCheck, !acceptable.contains(facts.uid) {
            let want = acceptable.sorted().map(String.init).joined(separator: " or ")
            throw EnvLoadError(
                message:
                    "\(envPath) owner uid is \(facts.uid), expected \(want) (\(deps.currentUser())). "
                    + "Refusing to load.",
                code: .wrongOwner)
        }

        if !skipModeCheck, (facts.mode & 0o777) != 0o600 {
            let observed = String(facts.mode & 0o777, radix: 8)
            let padded = String(repeating: "0", count: max(0, 3 - observed.count)) + observed
            throw EnvLoadError(
                message: "\(envPath) mode is 0\(padded), expected 0600. Run: chmod 0600 \(envPath)",
                code: .wrongMode)
        }

        let text = try deps.readFile(envPath)
        var vars = parse(text)
        try validateRequired(vars, envPath: envPath)
        try applyDerived(&vars)

        return finalize(vars: vars, opsDir: opsDir)
    }

    /// Assemble a `LoadedEnv` from an already-derived var bag. Exposed so the
    /// render-all pipeline (and tests) can build the environment from a var bag
    /// without touching the filesystem.
    public static func finalize(vars: [String: String], opsDir: String) -> LoadedEnv {
        LoadedEnv(
            vars: vars,
            labels: OpsLabels(
                proxy: vars["LABEL_PROXY"] ?? "",
                web: vars["LABEL_WEB"] ?? "",
                mcp: vars["LABEL_MCP"] ?? "",
                tunnelWeb: vars["LABEL_TUNNEL_WEB"] ?? "",
                tunnelMcp: vars["LABEL_TUNNEL_MCP"] ?? "",
                watchdog: vars["LABEL_WATCHDOG"] ?? "",
                autoroll: vars["LABEL_AUTOROLL"] ?? ""),
            staticDir: vars["STATIC_DIR"] ?? "",
            opsDir: opsDir,
            repoDir: vars["REPO_DIR"] ?? "",
            dataDir: vars["DATA_DIR"] ?? "",
            bunBin: vars["BUN_BIN"] ?? "")
    }

    /// Parse `KEY=VALUE` lines. Skips comments + blanks, strips matched outer
    /// single/double quotes from VALUE, rejects keys that aren't valid
    /// identifier shapes. Mirrors env.js `parseEnvFile`.
    public static func parse(_ text: String) -> [String: String] {
        var out: [String: String] = [:]
        for rawLine in splitLines(text) {
            let line = stripLeadingWhitespace(rawLine)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eqIndex = line.firstIndex(of: "=") else { continue }
            if eqIndex == line.startIndex { continue }  // eq <= 0
            let key = String(line[line.startIndex ..< eqIndex])
            var value = String(line[line.index(after: eqIndex)...])
            if !isValidKey(key) { continue }
            if value.count >= 2, let first = value.first, let last = value.last,
                (first == "\"" && last == "\"") || (first == "'" && last == "'")
            {
                value = String(value.dropFirst().dropLast())
            }
            out[key] = value
        }
        return out
    }

    /// Throw `missing-required` if any REQUIRED var is unset/empty.
    public static func validateRequired(_ vars: [String: String], envPath: String) throws {
        let missing = requiredVars.filter { (vars[$0] ?? "").isEmpty }
        if !missing.isEmpty {
            throw EnvLoadError(
                message:
                    "required variables are unset in \(envPath): \(missing.joined(separator: ", "))",
                code: .missingRequired)
        }
    }

    /// Synthesize the derived vars from the primaries. Mutates in place; throws
    /// `bad-channel` on an invalid SNAPSHOT_CHANNEL. Mirrors env.js `applyDerived`.
    public static func applyDerived(_ vars: inout [String: String]) throws {
        let prefix = vars["LABEL_PREFIX"] ?? ""
        vars["LABEL_PROXY"] = "\(prefix).proxy"
        vars["LABEL_WEB"] = "\(prefix).web"
        vars["LABEL_MCP"] = "\(prefix).mcp"
        vars["LABEL_TUNNEL_WEB"] = "\(prefix).cloudflared.web"
        vars["LABEL_TUNNEL_MCP"] = "\(prefix).cloudflared.mcp"
        vars["LABEL_WATCHDOG"] = "\(prefix).watchdog"
        vars["LABEL_AUTOROLL"] = "\(prefix).autoroll"
        vars["AUTOROLL_WEEKDAY"] = orDefault(vars["AUTOROLL_WEEKDAY"], "0")
        vars["AUTOROLL_HOUR"] = orDefault(vars["AUTOROLL_HOUR"], "14")
        vars["STATIC_DIR"] = orDefault(vars["STATIC_DIR"], "\(vars["REPO_DIR"] ?? "")/dist/web")
        vars["APPLE_DOCS_MCP_CACHE_SCALE"] = orDefault(vars["APPLE_DOCS_MCP_CACHE_SCALE"], "1")
        vars["APPLE_DOCS_NATIVE"] = vars["APPLE_DOCS_NATIVE"] ?? ""
        vars["LEGACY_LAUNCHD_LABELS"] = vars["LEGACY_LAUNCHD_LABELS"] ?? ""
        let channel = orDefault(vars["SNAPSHOT_CHANNEL"], "stable")
        vars["SNAPSHOT_CHANNEL"] = channel
        if channel != "stable" && channel != "beta" {
            throw EnvLoadError(
                message: "SNAPSHOT_CHANNEL must be \"stable\" or \"beta\", got \"\(channel)\"",
                code: .badChannel)
        }
    }

    // MARK: - default deps

    /// Read a file as UTF-8 text.
    public static let defaultRead: @Sendable (String) throws -> String = { path in
        try String(contentsOfFile: path, encoding: .utf8)
    }

    /// File permission bits + owner uid, via FileManager (avoids the C `stat`
    /// struct/function name clash). `mode` holds the POSIX permission bits; the
    /// owner check reads `uid`. Throws when the path is absent/unreadable.
    public static let defaultStat: @Sendable (String) throws -> FileFacts = { path in
        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        guard let permissions = attributes[.posixPermissions] as? NSNumber,
            let uid = attributes[.ownerAccountID] as? NSNumber
        else {
            throw EnvLoadError(message: "cannot stat \(path)", code: .missing)
        }
        return FileFacts(mode: permissions.uint32Value, uid: uid.uint32Value)
    }

    /// The invoking user's login name.
    public static let defaultCurrentUser: @Sendable () -> String = {
        NSUserName()
    }

    /// The current process uid (bodies use Foundation; the closure type does not,
    /// so these are usable as public default arguments).
    public static let defaultCurrentUid: @Sendable () -> UInt32 = { UInt32(getuid()) }

    /// `SUDO_UID` from the environment, if present.
    public static let defaultSudoUid: @Sendable () -> String? = {
        ProcessInfo.processInfo.environment["SUDO_UID"]
    }
}

// MARK: - string helpers (JS-faithful)

/// JS `String.prototype.split(/\r?\n/)`.
private func splitLines(_ text: String) -> [Substring] {
    text.split(separator: "\n", omittingEmptySubsequences: false)
        .map {
            $0.hasSuffix("\r") ? $0.dropLast() : $0
        }
}

/// Strip leading ASCII whitespace (space/tab/CR/FF/VT) — the realistic subset of
/// JS `\s` that appears in a `.env` file.
private func stripLeadingWhitespace(_ line: Substring) -> Substring {
    var start = line.startIndex
    while start < line.endIndex, isAsciiSpace(line[start]) {
        start = line.index(after: start)
    }
    return line[start...]
}

private func isAsciiSpace(_ character: Character) -> Bool {
    character == " " || character == "\t" || character == "\r" || character == "\u{0C}"
        || character == "\u{0B}"
}

/// `/^[A-Za-z_][A-Za-z0-9_]*$/`.
private func isValidKey(_ key: String) -> Bool {
    var scalars = key.unicodeScalars.makeIterator()
    guard let first = scalars.next(), isIdentStartScalar(first) else { return false }
    while let next = scalars.next() {
        if !isIdentContScalar(next) { return false }
    }
    return true
}

private func isIdentStartScalar(_ scalar: Unicode.Scalar) -> Bool {
    (scalar >= "A" && scalar <= "Z") || (scalar >= "a" && scalar <= "z") || scalar == "_"
}

private func isIdentContScalar(_ scalar: Unicode.Scalar) -> Bool {
    isIdentStartScalar(scalar) || (scalar >= "0" && scalar <= "9")
}

/// JS `vars.X || fallback` — falls back on `nil` OR empty string.
private func orDefault(_ value: String?, _ fallback: String) -> String {
    guard let value, !value.isEmpty else { return fallback }
    return value
}

/// Minimal path join (single separator between non-empty parts).
func joinPath(_ base: String, _ component: String) -> String {
    if base.isEmpty { return component }
    if base.hasSuffix("/") { return base + component }
    return base + "/" + component
}
