public import AppleDocsSetup

extension AssetRenderService {
    /// Renders an SF Symbol to a square PNG (`rsvg-convert` / `resvg` via ``SVGRasterizer``) at `size` pixels.
    public static func renderSFSymbolPNG(
        name: String,
        scope: String = "public",
        size: Int = 128,
        color: String = "currentColor",
        background: String = "transparent",
        resourcesDirectory: String
    ) async throws(SetupError) -> [UInt8] {
        let clamped = max(8, min(size, 1_024))
        let svg = try renderSFSymbolSVG(
            name: name,
            scope: scope,
            size: clamped,
            color: color == "currentColor" ? "#000000" : color,  // rasterizers have no CSS context for currentColor
            background: background,
            resourcesDirectory: resourcesDirectory
        )
        return try await SVGRasterizer.rasterizeToPNG(svg: svg, size: clamped)
    }
}
