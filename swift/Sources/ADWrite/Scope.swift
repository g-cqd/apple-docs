// Opt-in corpus scoping — the native port of `src/lib/scope.js` (issue #7).
// A `scope.json` at the root of the data directory narrows what `sync`
// refreshes and what `prune` keeps. Every field except `version` is optional;
// no scope.json at all → `load` returns nil and callers behave exactly as
// before (full coverage stays the default).
//
//   {
//     "version": 1,
//     "sources": ["apple-docc", "hig", "swift-book"],
//     "appleDoccFrameworks": ["swiftui", "combine"],
//     "keepFonts": true,
//     "keepSymbols": false
//   }

import Foundation

/// The loaded, normalized scope (`loadScope`'s return shape).
public struct CorpusScope: Sendable, Equatable {
    /// Allowed source types, or nil for all sources.
    public let sources: [String]?
    /// apple-docc root allow-list, or nil for every framework.
    public let appleDoccFrameworks: [String]?
    public let keepFonts: Bool
    public let keepSymbols: Bool
}

/// `loadScope(dataDir)` + `normalizeScope` — load and validate
/// `<dataDir>/scope.json`.
public enum ScopeLoader {
    public static let scopeFile = "scope.json"

    /// Load `<dataDir>/scope.json`. Absent file → nil (the hard-required
    /// "no scope, no behavior change" contract). `validSources` is the source
    /// adapter registry's type list (the JS `getAdapterTypes()`); `log`
    /// receives the "Scope active" info line.
    public static func load(
        dataDir: String, validSources: [String], log: ((String) -> Void)? = nil
    ) throws -> CorpusScope? {
        let path = dataDir + "/" + scopeFile
        guard FileManager.default.fileExists(atPath: path) else { return nil }
        let raw: Any
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            raw = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        } catch {
            throw MaintenanceError("\(path) is not valid JSON: \(error.localizedDescription)")
        }
        let scope = try normalize(raw, path: path, validSources: validSources)
        var line = "Scope active (\(scopeFile)): sources=\(scope.sources?.joined(separator: ",") ?? "all")"
        if let frameworks = scope.appleDoccFrameworks {
            line += "; apple-docc=[\(frameworks.joined(separator: ","))]"
        }
        line += "; fonts=\(scope.keepFonts ? "keep" : "drop"); symbols=\(scope.keepSymbols ? "keep" : "drop")"
        log?(line)
        return scope
    }

    /// `normalizeScope(raw, path)` — shape/version checks, source + framework
    /// list normalization, and the fonts/symbols defaults (`!== false`).
    static func normalize(_ raw: Any, path: String, validSources: [String]) throws -> CorpusScope {
        guard let object = raw as? [String: Any] else {
            throw MaintenanceError("\(path): expected a JSON object")
        }
        guard let version = object["version"] as? NSNumber, !isBool(version), version.intValue == 1 else {
            throw MaintenanceError(
                "\(path): unsupported version \(jsonStringify(object["version"])) (expected 1)")
        }
        let sources = try normalizeStringList(object["sources"], field: "sources", path: path)
        if let sources {
            let known = Set(validSources)
            let unknown = sources.filter { !known.contains($0) }
            if !unknown.isEmpty {
                throw MaintenanceError(
                    "\(path): unknown source(s): \(unknown.joined(separator: ", ")) "
                        + "(valid: \(known.sorted().joined(separator: ", ")))")
            }
        }
        let frameworks = try normalizeStringList(
            object["appleDoccFrameworks"], field: "appleDoccFrameworks", path: path)
        if frameworks != nil, let sources, !sources.contains("apple-docc") {
            throw MaintenanceError("\(path): appleDoccFrameworks is set but \"apple-docc\" is not in sources")
        }
        return CorpusScope(
            sources: sources, appleDoccFrameworks: frameworks,
            keepFonts: keepFlag(object["keepFonts"]), keepSymbols: keepFlag(object["keepSymbols"]))
    }

    /// `normalizeStringList`: nil for absent, else an array of strings
    /// (anything else throws), trimmed + lowercased + deduped (insertion
    /// order) + empties dropped; an empty result collapses to nil.
    private static func normalizeStringList(
        _ value: Any?, field: String, path: String
    ) throws -> [String]? {
        guard let value, !(value is NSNull) else { return nil }
        guard let array = value as? [Any], array.allSatisfy({ $0 is String }) else {
            throw MaintenanceError("\(path): \(field) must be an array of strings")
        }
        var seen = Set<String>()
        var list: [String] = []
        for case let item as String in array {
            let normalized = item.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !normalized.isEmpty, seen.insert(normalized).inserted else { continue }
            list.append(normalized)
        }
        return list.isEmpty ? nil : list
    }

    /// `raw.keepX !== false` — only the literal JSON `false` drops.
    private static func keepFlag(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, isBool(number) else { return true }
        return number.boolValue
    }

    /// JSONSerialization bridges JSON booleans to NSNumber; tell them apart
    /// from real numbers (JS `version: true` must NOT pass the `=== 1` check).
    private static func isBool(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// `JSON.stringify(value)` for the version error message (best effort).
    private static func jsonStringify(_ value: Any?) -> String {
        guard let value, !(value is NSNull) else { return value == nil ? "undefined" : "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
            let text = String(data: data, encoding: .utf8)
        {
            return text
        }
        return String(describing: value)
    }
}
