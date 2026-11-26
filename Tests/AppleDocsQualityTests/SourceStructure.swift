/// Enforces the repository source-structure rules:
/// - At most one non-private/non-fileprivate top-level type per Swift file, named after the file.
/// - Only `private` or `fileprivate` supporting types may share the same file.
/// - Extension-only files extend a single type and are named `Type+Feature.swift`.
/// - No hand-authored Swift file exceeds 250 lines across `Sources/` and `Tests/`.
enum SourceStructure {
    static let maximumLines = 250

    /// Returns one diagnostic sentence per violation; empty when every file conforms.
    static func problems(in files: [(name: String, text: String)]) -> [String] {
        var findings: [String] = []
        for file in files where !file.name.hasPrefix("Generated") {
            let lineCount = file.text.split(separator: "\n", omittingEmptySubsequences: false).count - 1
            if lineCount > maximumLines {
                findings.append("\(file.name): \(lineCount) lines, over \(maximumLines)")
            }
            findings += namingProblems(of: file)
        }
        return findings
    }

    /// Extracts visible (non-private/non-fileprivate) top-level type declarations and extensions.
    static func declarations(in text: String) -> (types: [String], extensions: [String]) {
        var types: [String] = []
        var extensions: [String] = []
        let keywords: Set<String> = ["struct", "class", "enum", "protocol", "actor"]
        let privateAccess: Set<String> = ["private", "fileprivate"]
        let modifiers: Set<String> = [
            "public", "internal", "private", "fileprivate", "final",
            "indirect", "package", "open", "nonisolated", "distributed"
        ]

        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let first = line.first,
                first != " ", first != "\t", first != "}", first != "/", first != "\""
            else {
                continue
            }
            var words = withoutAttributes(String(line))
                .split(whereSeparator: { " (:{<".contains($0) })
                .map(String.init)
            var isPrivate = false
            while let head = words.first, modifiers.contains(head) {
                if privateAccess.contains(head) { isPrivate = true }
                words.removeFirst()
            }
            guard words.count >= 2 else { continue }
            if keywords.contains(words[0]) {
                if !isPrivate {
                    types.append(words[1])
                }
            } else if words[0] == "extension", !isPrivate {
                extensions.append(words[1])
            }
        }
        return (types, extensions)
    }

    private static func namingProblems(of file: (name: String, text: String)) -> [String] {
        let stem = String(file.name.dropLast(".swift".count))
        let owner = String(stem.split(separator: "+", omittingEmptySubsequences: false).first ?? "")
        let (types, extensions) = declarations(in: file.text)

        if types.count > 1 {
            return [
                "\(file.name): declares \(types.count) visible top-level types (\(types.joined(separator: ", ")))"
            ]
        }
        if let type = types.first {
            if type == owner || file.name == "main.swift" {
                return []
            }
            return ["\(file.name): declares \(type), expected \(type).swift or \(type)+….swift"]
        }
        guard let firstExtension = extensions.first else { return [] }
        let uniqueExtensions = Set(extensions)
        if uniqueExtensions.count > 1 {
            return [
                "\(file.name): extends several types (\(uniqueExtensions.sorted().joined(separator: ", ")))"
            ]
        }
        let expected = String(firstExtension.map { $0 == "." ? "+" : $0 })
        if stem == expected || stem.hasPrefix(expected + "+") {
            return []
        }
        return ["\(file.name): extends \(firstExtension), expected \(expected)+….swift"]
    }

    private static func withoutAttributes(_ line: String) -> String {
        var rest = Substring(line)
        while rest.hasPrefix("@") {
            var depth = 0
            var end = rest.startIndex
            scan: for index in rest.indices {
                end = index
                switch rest[index] {
                    case "(": depth += 1
                    case ")": depth -= 1
                    case " " where depth == 0: break scan
                    default: continue
                }
            }
            rest = rest[end...].drop { $0 == " " }
        }
        return String(rest)
    }
}
