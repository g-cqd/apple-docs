/// Canonical documentation source identifiers across the corpus.
public enum SourceKind: String, Hashable, Sendable, Codable, CaseIterable {
    case appleDocC = "apple-docc"
    case hig = "hig"
    case guidelines = "guidelines"
    case swiftEvolution = "swift-evolution"
    case swiftBook = "swift-book"
    case swiftDocC = "swift-docc"
    case swiftOrg = "swift-org"
    case appleArchive = "apple-archive"
    case wwdc = "wwdc"
    case sampleCode = "sample-code"
    case packages = "packages"
}
