// Read-side containment for `apple_font_files.file_path` — the Swift port of
// `resources/apple-fonts/safe-font-path.js`'s `assertFontPathContained`. Without this check a
// malicious DB row (or a sync-time bug) that lands a `file_path` outside the approved roots
// would let a route serve arbitrary filesystem bytes; every read enforces the invariant.
//
// Two containment surfaces exist because they see different context:
//   - The MCP `render_font_text` tool (Tools.swift) has NO `dataDir` (`MCPCommand` opens only
//     `--db`, so `MCPToolContext` carries just a connection + logger), so it can only check the
//     three dataDir-INDEPENDENT system roots — a documented, narrower deviation from the JS
//     oracle (see `renderFontTextCore`'s own doc in Tools.swift).
//   - `ad-server serve`'s HTTP routes (`/api/fonts/text.svg`, `/api/fonts/file/:id`,
//     `/api/fonts/family/:id.zip`) DO have a resolved `dataDir` (from `--home` /
//     `$APPLE_DOCS_HOME` / the `~/.apple-docs` default — see `CorpusOptions.dataDir` in
//     Main.swift), so they check all four JS roots.

import Foundation

enum FontPathContainment {
    /// The dataDir-INDEPENDENT roots: the two system font directories plus the user's own
    /// `~/Library/Fonts` — mirrors `FontSync.defaultFontDirs` (the same three directories the
    /// sync-time discovery walks).
    private static var systemRoots: [String] {
        ["/Library/Fonts", "/System/Library/Fonts", "\(NSHomeDirectory())/Library/Fonts"]
    }

    /// The full approved-root set: the three system roots plus (when `dataDir` is known)
    /// `<dataDir>/resources/fonts/extracted` — where `FontSync.syncAppleFonts` and
    /// `apple-docs setup --download-fonts` extract Apple's downloadable font DMGs.
    static func approvedRoots(dataDir: String?) -> [String] {
        var roots = systemRoots
        if let dataDir, !dataDir.isEmpty {
            roots.append("\(dataDir)/resources/fonts/extracted")
        }
        return roots.map { URL(fileURLWithPath: $0).standardizedFileURL.path }
    }

    /// True if `filePath` canonicalizes under one of the approved roots (or equals one exactly
    /// — the JS `resolved === root.slice(0, -1)` edge case, though a font's `file_path` should
    /// never legitimately equal a root directory itself). `nil`/empty is never contained.
    static func isContained(_ filePath: String?, dataDir: String?) -> Bool {
        guard let filePath, !filePath.isEmpty else { return false }
        let resolved = URL(fileURLWithPath: filePath).standardizedFileURL.path
        return approvedRoots(dataDir: dataDir).contains { root in
            resolved == root || resolved.hasPrefix(root + "/")
        }
    }
}
