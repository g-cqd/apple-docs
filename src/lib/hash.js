/**
 * @param {string | Uint8Array | ArrayBuffer} data
 * @returns {string} lowercase hex digest
 */
export function sha256(data) {
  return new Bun.CryptoHasher('sha256').update(data).digest('hex')
}

/**
 * Stream a file through the hasher in chunks. Use this for snapshot DBs and
 * archives: `Bun.file(path).arrayBuffer()` allocates the whole file as one
 * ArrayBuffer, which aborts the process (SIGTRAP) once the corpus pushes those
 * files past the engine's max buffer size (multi-GB). Streaming is O(1) memory.
 * @param {string} path
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256File(path) {
  const hasher = new Bun.CryptoHasher('sha256')
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
  return hasher.digest('hex')
}
