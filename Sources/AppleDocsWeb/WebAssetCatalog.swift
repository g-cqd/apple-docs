import Foundation

/// The UI's static assets (`/assets/<name>`), loaded once from the module bundle and kept in memory.
enum WebAssetCatalog {
    /// One servable asset.
    struct Asset: Sendable {
        let bytes: [UInt8]
        let contentType: String
    }

    private static let manifest: [(name: String, ext: String, contentType: String)] = [
        ("style", "css", "text/css; charset=utf-8"),
        ("app", "js", "text/javascript; charset=utf-8")
    ]

    /// Every bundled asset keyed by its public file name (`style.css`, `app.js`).
    static let assets: [String: Asset] = {
        var loaded: [String: Asset] = [:]
        for entry in manifest {
            guard let url = Bundle.module.url(forResource: entry.name, withExtension: entry.ext),
                let data = try? Data(contentsOf: url)
            else { continue }
            loaded["\(entry.name).\(entry.ext)"] = Asset(bytes: Array(data), contentType: entry.contentType)
        }
        return loaded
    }()

    /// The asset named exactly `name` (no path segments), if bundled.
    static func asset(named name: String) -> Asset? {
        assets[name]
    }
}
