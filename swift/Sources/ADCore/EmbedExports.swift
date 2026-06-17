// Embed FFI surface. Byte layouts are shared verbatim — change both sides
// together.
//
// init request (little-endian):
//   [u32 version=1]
//   [u32 len][matrixPath utf8]
//   [u32 vocabCount] then vocabCount × { u32 len, token utf8 } in id order
//   [u32 addedCount] then addedCount × { u32 id, u32 len, content utf8 }
//   [u32 len][unkToken utf8]
//   [u32 len][continuingSubwordPrefix utf8]
//   [u32 maxInputCharsPerWord]
// result payload: [u32 dims][u32 rows][u32 behaviorVersion] — pre-v2 dylibs
// emit 8 bytes; JS treats a missing third field as behavior v1.
//
// batch request: [u32 version=1][u32 textCount] then per text { u32 len,
// utf8 }; result payload: textCount × dims f32 LE (unit-norm vectors).
//
// State: ONE process-wide embedder behind a pthread mutex. Re-init while
// initialized is idempotent-ignore (returns the existing dims/rows — JS
// initializes once per process). `ad_embed_reset` is a documented test seam;
// in-flight batches survive a concurrent reset because they hold their own
// reference to the mmap'd matrix (munmap runs when the last reference
// drops), so row pointers never dangle.

import ADBase
import ADEmbed
import ADFCore

#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private let maxBatchTexts = 65536
private let maxVocabTokens = 1 << 20
private let maxAddedTokens = 1024

private final class EmbedRuntime: @unchecked Sendable {
  // @unchecked: all access to `current` goes through the mutex.
  static let shared = EmbedRuntime()

  private let mutex: UnsafeMutablePointer<pthread_mutex_t> = {
    let pointer = UnsafeMutablePointer<pthread_mutex_t>.allocate(capacity: 1)
    pthread_mutex_init(pointer, nil)
    return pointer
  }()
  private var current: (embedder: Embedder, rows: Int)?

  private func withLock<T>(_ body: () -> T) -> T {
    pthread_mutex_lock(mutex)
    defer { pthread_mutex_unlock(mutex) }
    return body()
  }

  func snapshot() -> (embedder: Embedder, rows: Int)? {
    withLock { current }
  }

  /// First initializer wins; later calls get the existing dimensions.
  func adopt(_ embedder: Embedder, rows: Int) -> (dims: Int, rows: Int) {
    withLock {
      if let existing = current { return (existing.embedder.dims, existing.rows) }
      current = (embedder, rows)
      return (embedder.dims, rows)
    }
  }

  func reset() {
    withLock { current = nil }
  }
}

@_cdecl("ad_embed_init")
public func adEmbedInit(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized init request (\(len) bytes)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported embed init version")
  }
  guard let matrixPath = reader.lengthString(max: 1 << 20), !matrixPath.isEmpty else {
    return ResultBuffer.error(.invalidInput, "truncated matrix path")
  }
  guard let rawVocabCount = reader.u32(), rawVocabCount <= maxVocabTokens else {
    return ResultBuffer.error(.invalidInput, "vocab count out of bounds")
  }
  var vocab: [String] = []
  vocab.reserveCapacity(Int(rawVocabCount))
  for _ in 0..<rawVocabCount {
    guard let token = reader.lengthString(max: 1 << 20) else {
      return ResultBuffer.error(.invalidInput, "truncated vocab token")
    }
    vocab.append(token)
  }
  guard let rawAddedCount = reader.u32(), rawAddedCount <= maxAddedTokens else {
    return ResultBuffer.error(.invalidInput, "added-token count out of bounds")
  }
  var added: [Tokenizer.AddedToken] = []
  added.reserveCapacity(Int(rawAddedCount))
  for _ in 0..<rawAddedCount {
    guard let id = reader.u32(), let content = reader.lengthString(max: 1 << 20) else {
      return ResultBuffer.error(.invalidInput, "truncated added token")
    }
    added.append(.init(content: content, id: Int32(bitPattern: id)))
  }
  guard let unkToken = reader.lengthString(max: 1 << 20),
    let prefix = reader.lengthString(max: 1 << 20),
    let maxChars = reader.u32(),
    reader.remaining == 0
  else { return ResultBuffer.error(.invalidInput, "truncated embed init tail") }

  // Tokenizer.init preconditions unk resolvability — validate here instead
  // (the export surface never traps).
  guard vocab.contains(unkToken) || added.contains(where: { $0.content == unkToken }) else {
    return ResultBuffer.error(.invalidInput, "unk token \(unkToken) missing from vocab and added tokens")
  }

  let matrix: MatrixArtifact
  do {
    matrix = try MatrixArtifact(path: matrixPath)
  } catch {
    return ResultBuffer.error(.invalidInput, "matrix artifact rejected: \(error)")
  }
  let tokenizer = Tokenizer(
    vocab: vocab,
    addedTokens: added,
    unkToken: unkToken,
    continuingSubwordPrefix: prefix,
    maxInputCharsPerWord: Int(maxChars),
  )
  let adopted = EmbedRuntime.shared.adopt(Embedder(tokenizer: tokenizer, matrix: matrix), rows: matrix.rows)

  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: 12) else {
    return nil
  }
  payload.storeBytes(of: UInt32(adopted.dims).littleEndian, toByteOffset: 0, as: UInt32.self)
  payload.storeBytes(of: UInt32(adopted.rows).littleEndian, toByteOffset: 4, as: UInt32.self)
  payload.storeBytes(of: EmbedBehavior.version.littleEndian, toByteOffset: 8, as: UInt32.self)
  return base
}

private struct BatchDecodeFailure: Error {
  let message: String
}

/// Shared batch-request decode for ad_embed_batch / ad_embed_batch_codes.
private func decodeBatchRequest(
  _ ptr: UnsafePointer<UInt8>?, _ len: Int
) -> Result<(embedder: Embedder, texts: [String]), BatchDecodeFailure> {
  guard len > 0, len <= maxInputBytes, ptr != nil else {
    return .failure(BatchDecodeFailure(message: "empty or oversized batch request (\(len) bytes)"))
  }
  guard let (embedder, _) = EmbedRuntime.shared.snapshot() else {
    return .failure(BatchDecodeFailure(message: "embedder not initialized (call ad_embed_init first)"))
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr!, count: len))
  guard let version = reader.u32(), version == 1 else {
    return .failure(BatchDecodeFailure(message: "unsupported embed batch version"))
  }
  guard let rawCount = reader.u32(), rawCount <= maxBatchTexts else {
    return .failure(BatchDecodeFailure(message: "batch text count out of bounds"))
  }
  var texts: [String] = []
  texts.reserveCapacity(Int(rawCount))
  for _ in 0..<rawCount {
    guard let text = reader.lengthString(max: maxInputBytes) else {
      return .failure(BatchDecodeFailure(message: "truncated batch text"))
    }
    texts.append(text)
  }
  guard reader.remaining == 0 else {
    return .failure(BatchDecodeFailure(message: "\(reader.remaining) trailing bytes in batch request"))
  }
  return .success((embedder, texts))
}

@_cdecl("ad_embed_batch")
public func adEmbedBatch(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  let decoded: (embedder: Embedder, texts: [String])
  switch decodeBatchRequest(ptr, len) {
  case .failure(let failure): return ResultBuffer.error(.invalidInput, failure.message)
  case .success(let value): decoded = value
  }
  let (embedder, texts) = decoded
  let dims = embedder.dims
  guard let rowBytes = dims.checkedMultiplied(by: 4),
    let payloadBytes = texts.count.checkedMultiplied(by: rowBytes)
  else {
    return ResultBuffer.error(.invalidInput, "embed result size overflow")
  }
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadBytes) else {
    return nil
  }
  for (index, text) in texts.enumerated() {
    do {
      let vector = try embedder.embed(text)
      let rowOffset = index * rowBytes
      for i in 0..<dims {
        payload.storeBytes(of: vector[i].bitPattern.littleEndian, toByteOffset: rowOffset + i * 4, as: UInt32.self)
      }
    } catch {
      free(base)
      return ResultBuffer.error(.internalError, "embed failed for text \(index): \(error)")
    }
  }
  return base
}

/// Same request as ad_embed_batch; payload = count × (dims/8 sign-code bytes
/// + dims+4 int8+scale bytes) — the exact blobs the index pipeline stores,
/// so only 580 B/chunk cross the bridge instead of the 2 KB f32 vector plus
/// a JS quantize pass.
@_cdecl("ad_embed_batch_codes")
public func adEmbedBatchCodes(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  let decoded: (embedder: Embedder, texts: [String])
  switch decodeBatchRequest(ptr, len) {
  case .failure(let failure): return ResultBuffer.error(.invalidInput, failure.message)
  case .success(let value): decoded = value
  }
  let (embedder, texts) = decoded
  let dims = embedder.dims
  let stride = dims / 8 + dims + 4
  guard let payloadBytes = texts.count.checkedMultiplied(by: stride) else {
    return ResultBuffer.error(.invalidInput, "embed result size overflow")
  }
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: payloadBytes) else {
    return nil
  }
  for (index, text) in texts.enumerated() {
    do {
      let vector = try embedder.embed(text)
      let sign = Quantize.signCode(vector)
      let i8 = Quantize.i8Code(vector)
      var offset = index * stride
      for byte in sign {
        payload.storeBytes(of: byte, toByteOffset: offset, as: UInt8.self)
        offset += 1
      }
      for byte in i8 {
        payload.storeBytes(of: byte, toByteOffset: offset, as: UInt8.self)
        offset += 1
      }
    } catch {
      free(base)
      return ResultBuffer.error(.internalError, "embed failed for text \(index): \(error)")
    }
  }
  return base
}

@_cdecl("ad_embed_reset")
public func adEmbedReset() {
  EmbedRuntime.shared.reset()
}
