import AemiJSONCore
import Foundation

/// Front matter and string helpers mirroring Bun's `lib/yaml.js` and `render-markdown.js` utilities.
extension BunMarkdownRenderer {
    /// `toFrontMatter(compactObject({ title, framework, role, role_heading, platforms, path }))`.
    static func frontMatter(_ header: Header) -> String {
        var lines = ["---"]
        let scalars: [(String, String?)] = [
            ("title", header.title), ("framework", header.framework), ("role", header.role),
            ("role_heading", header.roleHeading)
        ]
        for (key, value) in scalars {
            if let value { lines.append("\(key): \(quoteIfNeeded(value))") }
        }
        if let platforms = formattedPlatforms(header.platformsJSON) {
            lines.append("platforms: [\(platforms.map(quoteIfNeeded).joined(separator: ", "))]")
        }
        lines.append("path: \(quoteIfNeeded(header.key))")
        lines.append("---")
        return lines.joined(separator: "\n")
    }

    /// `quoteIfNeeded`: YAML-quotes empty, boolean/null-like, numeric, special-character, or multi-line values.
    static func quoteIfNeeded(_ value: String) -> String {
        let special = ":{}[],&*?|>!%#@`\"'"
        let numeric = !value.isEmpty && value.allSatisfy { $0 == "." || ($0.isASCII && $0.isNumber) }
        let needsQuotes =
            value.isEmpty || ["true", "false", "null"].contains(value) || numeric
            || value.contains(where: { special.contains($0) }) || value.contains("\n")
        guard needsQuotes else { return value }
        return "\"" + value.replacing("\\", with: "\\\\").replacing("\"", with: "\\\"") + "\""
    }

    /// `formatPlatforms`: `{"ios":"16.0",…}` → `["iOS 16.0+", …]` (a version-less entry prints its name alone).
    static func formattedPlatforms(_ json: String?) -> [String]? {
        guard let json, let root = try? AemiJSON.parse(Array(json.utf8)).root else { return nil }
        if let items = root.array { return items.map { $0.string ?? "" } }
        guard root.isObject else { return nil }
        var out: [String] = []
        root.forEachMember { platform, version in
            let name = prettyPlatform(platform)
            if let version = version.string, !version.isEmpty {
                out.append("\(name) \(version)+")
            } else {
                out.append(name)
            }
        }
        return out
    }

    // @dl:accept -- Bun's platform display-name table (string mapping, not shared logic)
    private static func prettyPlatform(_ platform: String) -> String {
        switch platform {
            case "ios": "iOS"
            case "macos": "macOS"
            case "watchos": "watchOS"
            case "tvos": "tvOS"
            case "visionos": "visionOS"
            case "maccatalyst": "Mac Catalyst"
            case "ipados": "iPadOS"
            default: platform
        }
    }

    /// `/\n{3,}/g → "\n\n"`.
    static func collapseBlankLines(_ text: String) -> String {
        var out = ""
        var newlines = 0
        for character in text {
            if character == "\n" {
                newlines += 1
                if newlines <= 2 { out.append(character) }
            } else {
                newlines = 0
                out.append(character)
            }
        }
        return out
    }

    /// `/\s+/g → " "`.
    static func collapseWhitespace(_ text: String) -> String {
        var out = ""
        var inWhitespace = false
        for character in text {
            if character.isWhitespace {
                if !inWhitespace { out.append(" ") }
                inWhitespace = true
            } else {
                inWhitespace = false
                out.append(character)
            }
        }
        return out
    }

    /// `humanize`: underscores to spaces, each word's first character uppercased.
    static func humanize(_ value: String) -> String {
        var out = ""
        var previousIsWord = false
        for character in value.replacing("_", with: " ") {
            let isWord = character.isLetter || character.isNumber || character == "_"
            out += (isWord && !previousIsWord) ? character.uppercased() : String(character)
            previousIsWord = isWord
        }
        return out
    }
}
