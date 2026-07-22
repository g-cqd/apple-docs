// `/assets/*` + `/worker/*` static serving — the native twin of Bun's
// `src/web/routes/{assets,worker}.route.js`. Both are DEV-fallback routes: in
// production Caddy serves `/assets/*` + `/worker/*` from `dist/web/` directly and
// these never run (assets.route.js:41-47). ad-server matches Bun serve's dev bytes
// WITHOUT shelling bun (the operator's build-only-bun decision):
//
//   - non-JS `/assets/*` (e.g. style.css) → streamed RAW from `--web-root`/assets,
//     exactly as Bun serve (which does NOT minify at serve time).
//   - `/assets/*.js` → the PRE-BUILT bundle from `--web-dist`/assets. Bun serve
//     bundles on the fly via `bun build`; the output is deterministic, so the
//     `web build` dist bundle is byte-identical (verified: core/listing/search-page
//     .js match to the byte). ad-server serves that build artifact instead of
//     bundling — no serve-time bun.
//   - `/worker/*` → verbatim from `--web-root`/worker (the build copies these
//     unchanged, so src == dist == Bun serve).
//
// Unset roots → 404 (production Caddy owns the routes). Header note: the engine's
// `.file` adds a strong size+mtime ETag that Bun's non-hashable assetCacheHeaders
// omit — benign on immutable assets (see P9).

import ADServeCore
import ADServeDSL
// HTTPCore: the response-status enum (`.forbidden`) MemberImportVisibility requires
// importing from its defining module.
import HTTPCore

enum WebAssets {
    /// `/assets/<file>` — non-JS raw from `--web-root`, JS from the `--web-dist`
    /// bundle. 403 on traversal (`..`/NUL), 404 on miss or an unconfigured root.
    /// The route carries `.cache(.immutable)` (Bun's assetCacheHeaders).
    static func asset(_ web: WebDocContext, file: String) -> ResponseContent {
        guard isSafe(file) else { return .plain(.forbidden, "Forbidden\n") }
        if fileExtension(file) == "js" {
            guard let dist = web.assetsDist else { return .notFound }
            return fileResponse(root: "\(dist)/assets", subpath: file, contentType: "text/javascript; charset=utf-8")
        }
        guard let src = web.assetsSrc else { return .notFound }
        return fileResponse(root: "\(src)/assets", subpath: file, contentType: mimeType(fileExtension(file)))
    }

    /// `/worker/<file>` — verbatim from `--web-root`/worker.
    static func worker(_ web: WebDocContext, file: String) -> ResponseContent {
        guard isSafe(file) else { return .plain(.forbidden, "Forbidden\n") }
        guard let src = web.assetsSrc else { return .notFound }
        return fileResponse(root: "\(src)/worker", subpath: file, contentType: "text/javascript; charset=utf-8")
    }

    private static func fileResponse(root: String, subpath: String, contentType: String) -> ResponseContent {
        guard !subpath.isEmpty else { return .notFound }
        return .file(root: root, subpath: subpath, contentType: contentType)
    }

    /// JS `file.includes('..') || file.includes('\0')` → 403.
    private static func isSafe(_ file: String) -> Bool {
        !file.contains("..") && !file.unicodeScalars.contains("\0")
    }

    private static func fileExtension(_ file: String) -> String {
        guard let dot = file.lastIndex(of: ".") else { return "" }
        return String(file[file.index(after: dot)...]).lowercased()
    }

    /// The JS `MIME_TYPES[ext] || 'application/octet-stream'` (src/web/responses.js).
    private static func mimeType(_ ext: String) -> String {
        switch ext {
            case "html": "text/html; charset=utf-8"
            case "css": "text/css; charset=utf-8"
            case "js": "text/javascript; charset=utf-8"
            case "json": "application/json; charset=utf-8"
            case "svg": "image/svg+xml; charset=utf-8"
            case "png": "image/png"
            case "ttf": "font/ttf"
            case "otf": "font/otf"
            case "ttc": "font/collection"
            case "zip": "application/zip"
            default: "application/octet-stream"
        }
    }
}

/// Matches `/assets/<file>` (the Bun `/^\/assets\//` pattern) → the file subpath.
func matchAssetsPath(_ path: Substring) -> String? {
    path.hasPrefix("/assets/") ? String(path.dropFirst(8)) : nil
}

/// Matches `/worker/<file>` (the Bun `/^\/worker\//` pattern) → the file subpath.
func matchWorkerPath(_ path: Substring) -> String? {
    path.hasPrefix("/worker/") ? String(path.dropFirst(8)) : nil
}
