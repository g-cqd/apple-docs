import Foundation

/// Maps absolute documentation URLs to corpus keys across sources — a port of Bun's `lib/link-resolver.js`
/// `mapUrlToKey` (developer.apple.com documentation/design/archive/WWDC videos, docs.swift.org books, swift.org
/// migration guide and evolution proposals, GitHub swift-evolution proposals).
public enum CrossSourceLinkMapper {
    private static let swiftOrgRedirects = [
        "documentation/concurrency": "swift-migration-guide/documentation/migrationguide",
        "documentation/package-manager": "swift-package-manager/documentation/packagemanagerdocs",
        "documentation/tspl": "swift-book/The-Swift-Programming-Language"
    ]

    public static func key(forURL raw: String) -> String? {
        guard let components = URLComponents(string: raw), let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https", let host = components.host?.lowercased()
        else { return nil }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        let isSwiftOrg = host == "swift.org" || host == "www.swift.org"
        if isSwiftOrg, let redirect = swiftOrgRedirects[trimSlashes(path)] { return redirect }
        switch host {
            case "developer.apple.com": return appleKey(path)
            case "docs.swift.org": return swiftDocsKey(path)
            case "github.com": return githubEvolutionKey(path)
            default: return isSwiftOrg ? swiftOrgKey(path) : nil
        }
    }

    private static func appleKey(_ path: String) -> String? {
        if path.hasPrefix("/documentation/") {
            let rest = stripTrailingSlashes(String(path.dropFirst("/documentation/".count)))
            return rest.isEmpty ? nil : rest.lowercased()
        }
        if path.hasPrefix("/design/") {
            let rest = stripTrailingSlashes(String(path.dropFirst()))
            return rest.isEmpty ? nil : rest.lowercased()
        }
        if path.hasPrefix("/library/archive/") {
            return archiveKey(stripTrailingSlashes(String(path.dropFirst("/library/archive/".count))))
        }
        return wwdcKey(path)
    }

    private static func archiveKey(_ path: String) -> String? {
        guard !path.isEmpty else { return nil }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count >= 2, let file = parts.last, let dot = file.lastIndex(of: ".") else {
            return "apple-archive/\(path)"
        }
        let ext = file[file.index(after: dot)...].lowercased()
        let base = String(file[..<dot])
        guard ext == "html" || ext == "htm", !base.isEmpty else { return "apple-archive/\(path)" }
        let dir = parts.dropLast().joined(separator: "/")
        let parent = parts.dropLast().last.map(String.init) ?? ""
        if base.lowercased() == "index" || base.lowercased() == parent.lowercased() { return "apple-archive/\(dir)" }
        return "apple-archive/\(dir)/\(base).\(ext)"
    }

    private static func wwdcKey(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count == 4, parts[0] == "videos", parts[1] == "play", parts[2].hasPrefix("wwdc"),
            parts[2].count == 8, parts[2].dropFirst(4).allSatisfy(\.isASCIIDigit), !parts[3].isEmpty,
            parts[3].allSatisfy(\.isASCIIDigit)
        else { return nil }
        return "wwdc/\(parts[2])-\(parts[3])"
    }

    private static func swiftDocsKey(_ path: String) -> String? {
        let prefixes = [
            ("/swift-book/", "swift-book"), ("/compiler/", "swift-compiler"), ("/swiftpm/", "swift-package-manager")
        ]
        for (prefix, root) in prefixes where path.hasPrefix(prefix) {
            let rest = stripTrailingSlashes(String(path.dropFirst(prefix.count)))
            return rest.isEmpty ? root : "\(root)/\(rest)"
        }
        return nil
    }

    private static func swiftOrgKey(_ path: String) -> String? {
        if path.hasPrefix("/migration/") {
            let rest = stripTrailingSlashes(String(path.dropFirst("/migration/".count)))
            return rest.isEmpty ? "swift-migration-guide" : "swift-migration-guide/\(rest)"
        }
        guard path.hasPrefix("/swift-evolution/proposals/") else { return nil }
        return evolutionKey(path)
    }

    private static func githubEvolutionKey(_ path: String) -> String? {
        let parts = path.split(separator: "/")
        guard parts.count >= 4, parts[0] == "apple" || parts[0] == "swiftlang", parts[1] == "swift-evolution",
            parts[2] == "blob" || parts[2] == "tree"
        else { return nil }
        return evolutionKey(path)
    }

    /// `/proposals/(\d{4}-[^/]+?)(?:\.md|\.html)?/?$` → `swift-evolution/<id>`.
    private static func evolutionKey(_ path: String) -> String? {
        guard let range = path.range(of: "/proposals/", options: .backwards) else { return nil }
        var name = String(path[range.upperBound...])
        if name.hasSuffix("/") { name.removeLast() }
        guard !name.contains("/") else { return nil }
        for ext in [".md", ".html"] where name.hasSuffix(ext) && name.count > ext.count + 5 {
            name.removeLast(ext.count)
            break
        }
        let digits = name.prefix(4)
        guard digits.count == 4, digits.allSatisfy(\.isASCIIDigit), name.dropFirst(4).first == "-",
            name.count > 5
        else { return nil }
        return "swift-evolution/\(name)"
    }

    private static func trimSlashes(_ path: String) -> String {
        stripTrailingSlashes(String(path.drop(while: { $0 == "/" })))
    }

    private static func stripTrailingSlashes(_ path: String) -> String {
        var out = Substring(path)
        while out.hasSuffix("/") { out = out.dropLast() }
        return String(out)
    }
}

extension Character {
    fileprivate var isASCIIDigit: Bool { isASCII && isNumber }
}
