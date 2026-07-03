// Render every *.tpl under ops/ to its sibling rendered file — the native port
// of ops/cmd/render-all.js.
//
// For launchd plists a name mapping is applied so the committed, label-agnostic
// filename (e.g. apple-docs.web.plist.tpl) lands at its label-prefixed
// counterpart (e.g. mt.everest.apple-docs.web.plist) — what install-daemons
// looks for. Every other template (Caddyfile, cloudflared yaml, sudoers, and the
// Linux systemd units) just drops the `.tpl` suffix.

/// Committed launchd template basename → the LABEL var whose value names the
/// rendered plist. Mirrors render-all.js's `LAUNCHD_NAME_MAP`.
let launchdNameMap: [String: String] = [
    "apple-docs.proxy.plist.tpl": "LABEL_PROXY",
    "apple-docs.web.plist.tpl": "LABEL_WEB",
    "apple-docs.mcp.plist.tpl": "LABEL_MCP",
    "apple-docs.watchdog.plist.tpl": "LABEL_WATCHDOG",
    "apple-docs.autoroll.plist.tpl": "LABEL_AUTOROLL",
    "cloudflared.apple-docs.plist.tpl": "LABEL_TUNNEL_WEB",
    "cloudflared.apple-docs-mcp.plist.tpl": "LABEL_TUNNEL_MCP"
]

public enum RenderAllMode: Sendable {
    case write
    /// Exit 1 if any output would differ from current on-disk content.
    case check
    /// Print what would render but don't write.
    case dryRun
}

/// One template's rendering outcome.
public struct RenderAllEntry: Sendable, Equatable {
    public let templatePath: String
    public let outputPath: String
    public let unresolved: [String]
    public let ignored: [String]
    public let byteCount: Int
    /// `check` mode only: the rendered bytes differ from the on-disk output.
    public let drift: Bool
}

/// The aggregate result of a render-all pass.
public struct RenderAllOutcome: Sendable {
    public let entries: [RenderAllEntry]
    public let renderedCount: Int
    public let driftCount: Int
    public let templateCount: Int
    public let exitCode: Int32
}

public enum RenderAll {
    /// Resolve a template's output path. Launchd plists (except the sudoers
    /// drop-in) map through `launchdNameMap`; everything else drops `.tpl`.
    public static func resolveOutput(
        template: String, opsDir: String, vars: [String: String],
        warn: (String) -> Void = { _ in }
    ) -> String {
        let launchdDir = joinPath(opsDir, "launchd")
        let base = lastPathComponent(template)
        let dir = parentPath(template)
        if dir == launchdDir, base != "sudoers.apple-docs-launchctl.tpl" {
            if let labelVar = launchdNameMap[base] {
                return joinPath(dir, "\(vars[labelVar] ?? "").plist")
            }
            warn("render-all: unknown launchd template \(base) — rendering at default path")
        }
        return stripTplSuffix(template)
    }

    /// Recursively discover `*.tpl` files under `root`, sorted (byte order, to
    /// match the JS `Array.sort()` on ASCII paths).
    public static func findTemplates(root: String, fs: any OpsFileSystem) -> [String] {
        var out: [String] = []
        walk(root, fs, &out)
        out.sort { lexicographicallyLess(Array($0.utf8), Array($1.utf8)) }
        return out
    }

    private static func walk(_ dir: String, _ fs: any OpsFileSystem, _ out: inout [String]) {
        guard let entries = try? fs.listDir(dir) else { return }
        for entry in entries {
            let full = joinPath(dir, entry.name)
            if entry.isDirectory {
                walk(full, fs, &out)
            } else if entry.isFile, full.hasSuffix(".tpl") {
                out.append(full)
            }
        }
    }

    /// Render every template under `env.opsDir`. Warnings + progress go through
    /// `logger`. `check` returns exit 1 on any drift; `write`/`dryRun` return 0.
    @discardableResult
    public static func run(
        env: LoadedEnv, mode: RenderAllMode, fs: any OpsFileSystem, logger: any OpsLogging
    ) -> RenderAllOutcome {
        let templates = findTemplates(root: env.opsDir, fs: fs)
        if templates.isEmpty {
            logger.warn("render-all: no *.tpl files under \(env.opsDir)")
            return RenderAllOutcome(
                entries: [], renderedCount: 0, driftCount: 0, templateCount: 0, exitCode: 0)
        }

        var entries: [RenderAllEntry] = []
        var driftCount = 0
        var renderedCount = 0
        for template in templates {
            let outPath = resolveOutput(
                template: template, opsDir: env.opsDir, vars: env.vars, warn: logger.warn)
            guard let text = fs.tryRead(template) else {
                logger.warn("render-all: cannot read \(template)")
                continue
            }
            let result = RenderTemplate.render(bytes: text, env: env.vars, allowed: allowedVarsSet)
            if !result.unresolved.isEmpty {
                logger.warn(
                    "render-all: unresolved vars in \(template): "
                        + result.unresolved.joined(separator: ", "))
            }

            var drift = false
            switch mode {
                case .check:
                    let existing = fs.tryRead(outPath) ?? []
                    if existing != result.contentBytes {
                        logger.warn("drift: \(outPath)")
                        drift = true
                        driftCount += 1
                    }
                case .dryRun:
                    logger.say("dry-run: \(template) → \(outPath) (\(result.contentBytes.count) bytes)")
                case .write:
                    do {
                        try fs.writeAtomic(outPath, result.contentBytes)
                        logger.say("rendered: \(template) → \(outPath)")
                        renderedCount += 1
                    } catch {
                        logger.error("render-all: write failed for \(outPath): \(error)")
                    }
            }

            entries.append(
                RenderAllEntry(
                    templatePath: template, outputPath: outPath, unresolved: result.unresolved,
                    ignored: result.ignored, byteCount: result.contentBytes.count, drift: drift))
        }

        switch mode {
            case .check:
                logger.say(
                    "render-all --check: \(driftCount) drift entries across \(templates.count) templates")
                return RenderAllOutcome(
                    entries: entries, renderedCount: 0, driftCount: driftCount,
                    templateCount: templates.count, exitCode: driftCount > 0 ? 1 : 0)
            case .dryRun:
                return RenderAllOutcome(
                    entries: entries, renderedCount: 0, driftCount: 0,
                    templateCount: templates.count, exitCode: 0)
            case .write:
                logger.say("render-all: \(renderedCount) of \(templates.count) templates rendered")
                return RenderAllOutcome(
                    entries: entries, renderedCount: renderedCount, driftCount: 0,
                    templateCount: templates.count, exitCode: 0)
        }
    }
}

// MARK: - path + ordering helpers

/// The final path component (JS `slice(lastIndexOf('/') + 1)`).
func lastPathComponent(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return path }
    return String(path[path.index(after: slash)...])
}

/// Everything before the final `/` (JS `slice(0, lastIndexOf('/'))`; no trailing slash).
func parentPath(_ path: String) -> String {
    guard let slash = path.lastIndex(of: "/") else { return "" }
    return String(path[path.startIndex ..< slash])
}

/// Drop a trailing `.tpl` (JS `replace(/\.tpl$/, '')`).
func stripTplSuffix(_ path: String) -> String {
    path.hasSuffix(".tpl") ? String(path.dropLast(4)) : path
}

/// Byte-lexicographic `<` (matches JS default `Array.sort()` on ASCII).
func lexicographicallyLess(_ lhs: [UInt8], _ rhs: [UInt8]) -> Bool {
    let count = min(lhs.count, rhs.count)
    var index = 0
    while index < count {
        if lhs[index] != rhs[index] { return lhs[index] < rhs[index] }
        index += 1
    }
    return lhs.count < rhs.count
}
