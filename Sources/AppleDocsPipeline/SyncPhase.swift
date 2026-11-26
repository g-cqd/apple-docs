/// Phases of the resumable corpus synchronization pipeline.
public enum SyncPhase: String, Hashable, Sendable, CaseIterable {
    case discover
    case update
    case crawl
    case convert
    case enrich
    case index
    case consolidate
    case embeddings
}
