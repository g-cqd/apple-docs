// Embed FFI surface (RFC 0002 phase 3). Byte layouts are shared verbatim
// with src/search/embedder-native.js — change both sides together.
//
// init request (little-endian):
//   [u32 version=1]
//   [u32 len][matrixPath utf8]
//   [u32 vocabCount] then vocabCount × { u32 len, token utf8 } in id order
//   [u32 addedCount] then addedCount × { u32 id, u32 len, content utf8 }
//   [u32 len][unkToken utf8]
//   [u32 len][continuingSubwordPrefix utf8]
//   [u32 maxInputCharsPerWord]
// result payload: [u32 dims][u32 rows]
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

private func readString(_ reader: inout RequestReader, max: Int = 1 << 20) -> String? {
  guard let length = reader.u32(), Int(length) <= max,
    let view = reader.bytes(Int(length))
  else { return nil }
  return String(decoding: view, as: UTF8.self)
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
  guard let matrixPath = readString(&reader), !matrixPath.isEmpty else {
    return ResultBuffer.error(.invalidInput, "truncated matrix path")
  }
  guard let rawVocabCount = reader.u32(), rawVocabCount <= maxVocabTokens else {
    return ResultBuffer.error(.invalidInput, "vocab count out of bounds")
  }
  var vocab: [String] = []
  vocab.reserveCapacity(Int(rawVocabCount))
  for _ in 0..<rawVocabCount {
    guard let token = readString(&reader) else {
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
    guard let id = reader.u32(), let content = readString(&reader) else {
      return ResultBuffer.error(.invalidInput, "truncated added token")
    }
    added.append(.init(content: content, id: Int32(bitPattern: id)))
  }
  guard let unkToken = readString(&reader),
    let prefix = readString(&reader),
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

  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: 8) else {
    return nil
  }
  payload.storeBytes(of: UInt32(adopted.dims).littleEndian, toByteOffset: 0, as: UInt32.self)
  payload.storeBytes(of: UInt32(adopted.rows).littleEndian, toByteOffset: 4, as: UInt32.self)
  return base
}

@_cdecl("ad_embed_batch")
public func adEmbedBatch(_ ptr: UnsafePointer<UInt8>?, _ len: Int) -> UnsafeMutableRawPointer? {
  guard len > 0, len <= maxInputBytes, let ptr else {
    return ResultBuffer.error(.invalidInput, "empty or oversized batch request (\(len) bytes)")
  }
  guard let (embedder, _) = EmbedRuntime.shared.snapshot() else {
    return ResultBuffer.error(.invalidInput, "embedder not initialized (call ad_embed_init first)")
  }
  var reader = RequestReader(UnsafeRawBufferPointer(start: ptr, count: len))
  guard let version = reader.u32(), version == 1 else {
    return ResultBuffer.error(.invalidInput, "unsupported embed batch version")
  }
  guard let rawCount = reader.u32(), rawCount <= maxBatchTexts else {
    return ResultBuffer.error(.invalidInput, "batch text count out of bounds")
  }
  var texts: [String] = []
  texts.reserveCapacity(Int(rawCount))
  for _ in 0..<rawCount {
    guard let text = readString(&reader, max: maxInputBytes) else {
      return ResultBuffer.error(.invalidInput, "truncated batch text")
    }
    texts.append(text)
  }
  guard reader.remaining == 0 else {
    return ResultBuffer.error(.invalidInput, "\(reader.remaining) trailing bytes in batch request")
  }

  let dims = embedder.dims
  guard let (base, payload) = ResultBuffer.allocate(status: .ok, format: .bytes, payloadCount: texts.count * dims * 4) else {
    return nil
  }
  for (index, text) in texts.enumerated() {
    do {
      let vector = try embedder.embed(text)
      let rowOffset = index * dims * 4
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

@_cdecl("ad_embed_reset")
public func adEmbedReset() {
  EmbedRuntime.shared.reset()
}
