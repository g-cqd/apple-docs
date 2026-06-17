/// Embedding behavior version, reported through ad_embed_init's result
/// payload and stamped into snapshot_meta (`embed_version`) by the index
/// pipeline. Bump on ANY deliberate change to tokenization, pooling or
/// quantization output.
///
/// v1 — bit-exact transformers.js 4.2.0 mirror (the port).
/// v2 — astral CJK spacing + half-away-from-zero i8 rounding.
public enum EmbedBehavior {
  public static let version: UInt32 = 2
}
