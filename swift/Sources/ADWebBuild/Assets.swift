// The S6 asset pipeline — the pure half of `src/web/build/assets-pipeline.js`
// (+ `minify-css.js`, `assets-manifest.js`, `lib/font-faces.js`).
//
// I/O stays inverted: `AssetSource` abstracts the `src/web/{assets,worker,public}`
// tree AND the `Bun.build` bundling seam (operator decision #3: `bun build`
// survives as a build-only subprocess — the ad-cli side shells it; CI/no-bun
// hosts get a passthrough). `BuildSite.planAssets` mirrors `runAssetPipeline`'s
// order exactly: minified CSS, entry bundles, standalone assets, worker files
// verbatim, then the public/ copy.
//
// Byte-parity notes:
//   - `bun build <entry> --target=browser --minify --format=iife` (the CLI) was
//     verified byte-identical to the `Bun.build` API output for all six bundles.
//   - `MinifyCss.minify` ports the five sequential regex passes of minify-css.js
//     over Unicode scalars, using the JS regex `\s` whitespace set.
//   - `FontFaces.buildFontFaceCss` ports lib/font-faces.js for the
//     `api/fonts/faces.css` sheet.

public import ADJSONCore

// MARK: - assets-manifest.js

/// Single source of truth for browser asset bundling (assets-manifest.js).
public enum AssetsManifest {
    /// Bundles emitted to `/assets/<output>`; each `entry` is a file under
    /// `src/web/assets/` importing the members in execution order
    /// (`ENTRY_BUNDLES`, in `Object.entries` insertion order).
    public static let entryBundles: [(output: String, entry: String)] = [
        ("core.js", "core.bundle.js"),
        ("listing.js", "listing.bundle.js")
    ]

    /// Single-file page controllers, bundled 1:1 to `/assets/<name>`
    /// (`STANDALONE_ASSETS`).
    public static let standaloneAssets = [
        "search-page.js", "fonts-page.js", "symbols-page.js", "lang-toggle.js"
    ]

    /// Files copied verbatim to `/worker/<name>` (`WORKER_ASSETS` — workers ship
    /// as their own ES-module files, no IIFE wrap).
    public static let workerAssets = ["search-worker.js"]
}

// MARK: - the I/O + bundler seam

/// The `src/web` static-asset tree + the `Bun.build` seam, as the planner needs
/// them. The ad-cli adapter reads the repo checkout and shells `bun build`;
/// tests use an in-memory mock.
public protocol AssetSource {
    /// UTF-8 bytes of `src/web/assets/<relative>`, or nil when absent.
    func readAsset(_ relative: String) -> [UInt8]?
    /// UTF-8 bytes of `src/web/worker/<relative>`, or nil when absent.
    func readWorker(_ relative: String) -> [UInt8]?
    /// Bundle + minify `src/web/assets/<relative>` as a browser IIFE — the
    /// `Bun.build` subprocess seam (or a passthrough when bun is unavailable).
    func bundle(assetEntry relative: String) throws -> [UInt8]
    /// Every file under `src/web/public/`, path relative to `public/` (these land
    /// at the build root: `llms.txt`, `.well-known/security.txt`, …).
    func publicFiles() throws -> [(path: String, bytes: [UInt8])]
}

/// Asset-pipeline failures (`runAssetPipeline` lets `readFileSync` throw).
public enum AssetPipelineError: Error, Sendable {
    /// `assets/style.css` is required — the JS pipeline crashes without it.
    case missingStylesheet
}

extension BuildSite {
    /// Port of `runAssetPipeline` (build.js step 2), as a pure artifact plan in
    /// the JS write order: `assets/style.css` (minified), the entry bundles, the
    /// standalone assets (skipped when the source file is absent, like the JS
    /// `existsSync` guard), the worker files verbatim, then the `public/` tree at
    /// the build root. The caller writes these BEFORE the essentials artifacts so
    /// the generated discovery files win over any stale committed copy, exactly
    /// as build.js orders steps 2 and 4.
    public static func planAssets(source: some AssetSource) throws -> [Artifact] {
        var artifacts: [Artifact] = []

        guard let rawCss = source.readAsset("style.css") else {
            throw AssetPipelineError.missingStylesheet
        }
        let minified = MinifyCss.minify(String(decoding: rawCss, as: UTF8.self))
        artifacts.append(Artifact(path: "assets/style.css", text: minified))

        for (output, entry) in AssetsManifest.entryBundles {
            artifacts.append(Artifact(path: "assets/\(output)", bytes: try source.bundle(assetEntry: entry)))
        }
        for file in AssetsManifest.standaloneAssets where source.readAsset(file) != nil {
            artifacts.append(Artifact(path: "assets/\(file)", bytes: try source.bundle(assetEntry: file)))
        }
        for file in AssetsManifest.workerAssets {
            if let bytes = source.readWorker(file) {
                artifacts.append(Artifact(path: "worker/\(file)", bytes: bytes))
            }
        }
        for (path, bytes) in try source.publicFiles() {
            artifacts.append(Artifact(path: path, bytes: bytes))
        }
        return artifacts
    }
}

// MARK: - minify-css.js

/// Port of `minifyCSS` — five sequential global regex passes, then `trim()`.
/// Each pass reproduces the JS regex semantics exactly (see the per-pass docs);
/// "whitespace" throughout is the JS regex `\s` set.
public enum MinifyCss {
    public static func minify(_ css: String) -> String {
        var scalars = Array(css.unicodeScalars)
        scalars = stripBlockComments(scalars)  // /\/\*[\s\S]*?\*\//g → ''
        scalars = collapseAroundSyntax(scalars)  // /\s*([{}:;,>~+])\s*/g → '$1'
        scalars = dropSemicolonBeforeBrace(scalars)  // /;\}/g → '}'
        scalars = scalars.filter { $0 != "\n" }  // /\n+/g → ''
        scalars = collapseWhitespaceRuns(scalars)  // /\s{2,}/g → ' '
        return trimmed(scalars)  // .trim()
    }

    /// The JS regex `\s` class (also `String.prototype.trim`'s set): ASCII
    /// whitespace + NBSP + the Unicode space separators + LS/PS + BOM.
    static func isJsWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
            case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000 ... 0x200A, 0x2028, 0x2029,
                0x202F, 0x205F, 0x3000, 0xFEFF:
                return true
            default:
                return false
        }
    }

    /// `{ } : ; , > ~ +` — the pass-2 capture class.
    private static func isSyntax(_ s: Unicode.Scalar) -> Bool {
        s == "{" || s == "}" || s == ":" || s == ";" || s == "," || s == ">" || s == "~" || s == "+"
    }

    /// `/\/\*[\s\S]*?\*\//g` → '': drop each `/* … */` (non-greedy — first
    /// closing `*/` ends the comment). An unterminated `/*` has no match and
    /// stays verbatim, like the regex.
    private static func stripBlockComments(_ input: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(input.count)
        var i = 0
        while i < input.count {
            if input[i] == "/", i + 1 < input.count, input[i + 1] == "*" {
                var k = i + 2
                while k + 1 < input.count, !(input[k] == "*" && input[k + 1] == "/") { k += 1 }
                if k + 1 < input.count {  // found the closing */
                    i = k + 2
                    continue
                }
            }
            out.append(input[i])
            i += 1
        }
        return out
    }

    /// `/\s*([{}:;,>~+])\s*/g` → '$1': each match consumes optional whitespace,
    /// ONE syntax char, and optional trailing whitespace; scanning resumes after
    /// the match (so `a ; ; b` → `a;;b`). Whitespace runs NOT followed by a
    /// syntax char pass through verbatim.
    private static func collapseAroundSyntax(_ input: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(input.count)
        var i = 0
        let n = input.count
        while i < n {
            if isJsWhitespace(input[i]) {
                var j = i
                while j < n, isJsWhitespace(input[j]) { j += 1 }
                if j < n, isSyntax(input[j]) {
                    out.append(input[j])
                    i = j + 1
                    while i < n, isJsWhitespace(input[i]) { i += 1 }  // trailing \s*
                } else {
                    out.append(contentsOf: input[i ..< j])
                    i = j
                }
            } else if isSyntax(input[i]) {
                out.append(input[i])
                i += 1
                while i < n, isJsWhitespace(input[i]) { i += 1 }  // trailing \s*
            } else {
                out.append(input[i])
                i += 1
            }
        }
        return out
    }

    /// `/;\}/g` → '}'.
    private static func dropSemicolonBeforeBrace(_ input: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(input.count)
        var i = 0
        while i < input.count {
            if input[i] == ";", i + 1 < input.count, input[i + 1] == "}" {
                out.append("}")
                i += 2
            } else {
                out.append(input[i])
                i += 1
            }
        }
        return out
    }

    /// `/\s{2,}/g` → ' ': runs of TWO OR MORE whitespace become one space; a
    /// single whitespace char stays as-is (a lone tab remains a tab).
    private static func collapseWhitespaceRuns(_ input: [Unicode.Scalar]) -> [Unicode.Scalar] {
        var out: [Unicode.Scalar] = []
        out.reserveCapacity(input.count)
        var i = 0
        let n = input.count
        while i < n {
            if isJsWhitespace(input[i]) {
                var j = i
                while j < n, isJsWhitespace(input[j]) { j += 1 }
                if j - i >= 2 {
                    out.append(" ")
                } else {
                    out.append(input[i])
                }
                i = j
            } else {
                out.append(input[i])
                i += 1
            }
        }
        return out
    }

    /// `String.prototype.trim()` — strip JS whitespace at both ends.
    private static func trimmed(_ input: [Unicode.Scalar]) -> String {
        var start = 0
        var end = input.count
        while start < end, isJsWhitespace(input[start]) { start += 1 }
        while end > start, isJsWhitespace(input[end - 1]) { end -= 1 }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: input[start ..< end])
        return String(view)
    }
}

// MARK: - lib/font-faces.js

/// Shared `@font-face` construction for the `/fonts` page — the static build's
/// `api/fonts/faces.css` sheet.
public enum FontFaces {
    /// CSS `font-family` name for one extracted font file (`fontFaceName`).
    public static func fontFaceName(familyId: String, fileId: String) -> String {
        "apple-docs-\(familyId)-\(fileId)"
    }

    /// Stored `format` → the CSS `format(...)` hint; empty when unknown (the
    /// caller then omits the clause), like `formatHint`.
    static func formatHint(_ format: String) -> String {
        switch format.lowercased() {
            case "ttf": return "truetype"
            case "otf": return "opentype"
            case "ttc": return "collection"
            default: return ""
        }
    }

    /// Port of `buildFontFaceCss(families, { fileUrl })`: one `@font-face` rule
    /// per family file, joined with `\n`. `families` is the parsed
    /// `listAppleFonts()` array (nil / non-array ⇒ no rules ⇒ empty string, the
    /// JS `families ?? []`); a family without a `files` array contributes
    /// nothing (`family.files ?? []`).
    public static func buildFontFaceCss(_ families: JSON?, fileUrl: (String) -> String) -> String {
        var rules: [String] = []
        families?
            .forEachElement { family in
                family["files"]
                    .forEachElement { file in
                        // JS template coercion of the ids; both are TEXT NOT NULL in the
                        // corpus, so the string read always hits (jsString covers a
                        // numeric id; a malformed null would render '' vs JS 'null').
                        let familyId = family["id"].string ?? family["id"].jsString
                        let fileId = file["id"].string ?? file["id"].jsString
                        let name = fontFaceName(familyId: familyId, fileId: fileId)
                        let url = fileUrl(fileId)
                        let format = formatHint(file["format"].string ?? file["format"].jsString)
                        let formatClause = format.isEmpty ? "" : " format(\"\(format)\")"
                        rules.append(
                            "@font-face { font-family: \"\(name)\"; src: url(\"\(url)\")\(formatClause); font-display: swap; }"
                        )
                    }
            }
        return rules.joined(separator: "\n")
    }

    /// The static build's file-URL builder (build.js):
    /// `` (id) => `${baseUrl || ''}/api/fonts/file/${encodeURIComponent(id)}` ``.
    public static func buildFileUrl(baseUrl: String) -> @Sendable (String) -> String {
        { id in "\(baseUrl)/api/fonts/file/\(WebHtml.encodeURIComponent(id))" }
    }
}
