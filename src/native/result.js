/**
 * Contract-v0 result reader (rfcs/0001-swift-native-transition/p0/ffi-bridge.md §2):
 * every native result is one allocation — 16-byte header
 * [u64 payloadLen LE][u32 status LE][u8 formatId][3 reserved] + payload —
 * which the JS side copies out of and frees exactly once.
 */
import { toArrayBuffer } from 'bun:ffi'

// Corruption guard: no legitimate payload approaches this.
const MAX_PAYLOAD_BYTES = 1 << 30

export const NATIVE_STATUS_OK = 0

/**
 * Copies header + payload out of a native result and frees it.
 *
 * @param {{ symbols: { ad_free: (ptr: unknown) => void } }} lib
 * @param {unknown} ptr non-null pointer returned by an ad_* export
 * @returns {{ status: number, formatId: number, bytes: Uint8Array }}
 */
export function readNativeResult(lib, ptr) {
  if (!ptr) throw new Error('native call returned NULL (allocation failure)')
  try {
    const header = new DataView(toArrayBuffer(ptr, 0, 16))
    const length = Number(header.getBigUint64(0, true))
    if (length > MAX_PAYLOAD_BYTES) throw new Error(`corrupt native payload length ${length}`)
    const bytes = new Uint8Array(length)
    if (length > 0) bytes.set(new Uint8Array(toArrayBuffer(ptr, 16, length)))
    return { status: header.getUint32(8, true), formatId: header.getUint8(12), bytes }
  } finally {
    lib.symbols.ad_free(ptr)
  }
}

/** Decodes an error payload (UTF-8 message) for logging. */
export function nativeErrorMessage(result) {
  return new TextDecoder().decode(result.bytes)
}
