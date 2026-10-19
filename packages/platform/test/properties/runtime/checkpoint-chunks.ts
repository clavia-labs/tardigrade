import * as fc from "fast-check"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import { checkpointDigest } from "@clavia/tardigrade-core"
import { encodeCheckpointChunks, decodeCheckpointChunks, validateCheckpointChunkBytes } from "../../../src/shared/checkpoint-chunks"

// checkpointChunks checks byte identity and structural rejection across write boundaries on every host.
export const checkpointChunks = fc.asyncProperty(fc.oneof(fc.uint8Array({ maxLength: 4096 }), fc.constant(new TextEncoder().encode("Aé😀Z"))), fc.integer({ min: 1, max: 256 }), async (payload, limit) => {
  for (const chunkBytes of [limit, 1, Math.max(1, payload.length), payload.length + 1, Number.MAX_SAFE_INTEGER]) {
    const before = payload.slice()
    const chunks = encodeCheckpointChunks(payload, chunkBytes)
    const decoded = decodeCheckpointChunks(chunks, payload.length, chunks.length)
    if (!isDeepStrictEqual(decoded, payload) || !isDeepStrictEqual(before, payload) || chunks.some(chunk => chunk.payload.length > chunkBytes)) throw new Error("Chunk codec changed bytes or exceeded the write limit")
    rejects(() => decodeCheckpointChunks(chunks, payload.length + 1, chunks.length))
    rejects(() => decodeCheckpointChunks(chunks, payload.length, chunks.length + 1))
    if (chunks.length) {
      rejects(() => decodeCheckpointChunks(chunks.slice(1), payload.length, chunks.length))
      rejects(() => decodeCheckpointChunks([{ ...chunks[0]!, ordinal: 1 }, ...chunks.slice(1)], payload.length, chunks.length))
      rejects(() => decodeCheckpointChunks([{ ordinal: 0, payload: new Uint8Array() }, ...chunks.slice(1)], payload.length, chunks.length))
      rejects(() => decodeCheckpointChunks([...chunks, chunks[0]!], payload.length, chunks.length))
    }
    if (chunks.length > 1) rejects(() => decodeCheckpointChunks([...chunks].reverse(), payload.length, chunks.length))
    if (decoded.length) { decoded[0] = decoded[0]! ^ 255; if (!isDeepStrictEqual(payload, before)) throw new Error("Decoded bytes alias the input") }
  }
  validateCheckpointChunkBytes(limit, limit)
  rejects(() => validateCheckpointChunkBytes(limit + 1, limit))
  for (const invalid of [0, -1, 0.5, NaN, Infinity]) rejects(() => encodeCheckpointChunks(payload, invalid))
  const backing = new Uint8Array(payload.length + 7).fill(255)
  backing.set(payload, 3)
  const view = backing.subarray(3, 3 + payload.length)
  const expected = Array.from(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", payload.slice().buffer)), byte => byte.toString(16).padStart(2, "0")).join("")
  if (await Effect.runPromise(checkpointDigest(view)) !== expected || !isDeepStrictEqual(view, payload)) throw new Error("Checkpoint digest changed bytes or hashed outside the selected view")
})

function rejects(run: () => unknown) {
  try { run() } catch { return }
  throw new Error("Invalid chunk representation was accepted")
}
