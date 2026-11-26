import Foundation

/// The UI's static assets (`/assets/<name>`), embedded in the binary (see `Scripts/embed-resources.py`).
enum WebAssetCatalog {
    /// One servable asset.
    struct Asset: Sendable {
        let bytes: [UInt8]
        let contentType: String
    }

    /// Every bundled asset keyed by its public file name (`style.css`, `app.js`), compiled into the binary.
    static let assets: [String: Asset] = [
        "style.css": Asset(bytes: Array(EmbeddedStylesheet.text.utf8), contentType: "text/css; charset=utf-8"),
        "app.js": Asset(bytes: Array(EmbeddedScript.text.utf8), contentType: "text/javascript; charset=utf-8")
    ]

    /// The asset named exactly `name` (no path segments), if bundled.
    static func asset(named name: String) -> Asset? {
        assets[name]
    }
}
