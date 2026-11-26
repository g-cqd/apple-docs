import AppleDocsCore
import Foundation

/// The committed DocC golden inputs (`Tests/AppleDocsContentTests/Fixtures/DocCParity`), read from the source tree.
enum DocCInputs {
    static func load(filePath: String = #filePath) -> [(key: DocumentKey, bytes: [UInt8])] {
        let fixtures = URL(fileURLWithPath: filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Tests/AppleDocsContentTests/Fixtures/DocCParity")
        guard let manifestData = try? Data(contentsOf: fixtures.appendingPathComponent("manifest.json")),
            let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [[String: String]]
        else { fatalError("missing DocC golden fixtures at \(fixtures.path)") }
        return manifest.compactMap { entry in
            guard let name = entry["name"], let rawKey = entry["key"], let key = try? DocumentKey(rawKey),
                let data = try? Data(contentsOf: fixtures.appendingPathComponent("\(name).input.json"))
            else { return nil }
            return (key, Array(data))
        }
    }
}
