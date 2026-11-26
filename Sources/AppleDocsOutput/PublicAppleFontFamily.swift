/// Public Apple Font family and its installed files projected across CLI `--json`, MCP `list_apple_fonts`, and Web.
///
/// Never exposes local filesystem paths (`file_path`) across public boundaries — only logical
/// `id`, `fileName`, style metadata, and `format`.
public struct PublicAppleFontFamily: Hashable, Sendable, Codable {
    /// Single font file entry inside a family.
    public struct FontFile: Hashable, Sendable, Codable {
        public let id: String
        public let fileName: String
        public let postscriptName: String?
        public let styleName: String?
        public let weight: String?
        public let italic: Bool?
        public let format: String?
        public let isVariable: Bool?

        public init(
            id: String,
            fileName: String,
            postscriptName: String? = nil,
            styleName: String? = nil,
            weight: String? = nil,
            italic: Bool = false,
            format: String? = nil,
            isVariable: Bool = false
        ) {
            self.id = id
            self.fileName = fileName
            self.postscriptName = postscriptName
            self.styleName = styleName
            self.weight = weight
            self.italic = italic ? true : nil
            self.format = format
            self.isVariable = isVariable ? true : nil
        }
    }

    public let id: String
    public let displayName: String
    public let category: String?
    public let status: String
    public let files: [FontFile]

    public init(
        id: String,
        displayName: String,
        category: String? = nil,
        status: String = "available",
        files: [FontFile] = []
    ) {
        self.id = id
        self.displayName = displayName
        self.category = category
        self.status = status
        self.files = files
    }
}
