import { createHash } from "node:crypto"
import { RuntimeError } from "@clavia/tardigrade-core"
import { decodeCheckpointChunks, type CheckpointChunk } from "./checkpoint-chunks"

export interface StoredPayloadRow {
  readonly payload: string | Uint8Array | ArrayBuffer
  readonly byte_length: number | null
  readonly chunk_count: number | null
  readonly digest: string | null
}
export interface StoredPayloadChunk { readonly ordinal: number; readonly payload: Uint8Array | ArrayBuffer }

// storedPayloadBytes restores complete bytes and rejects partial headers and chunk sequences (test/bun/journal.test.ts).
export function storedPayloadBytes(row: StoredPayloadRow, chunks: () => readonly StoredPayloadChunk[]): Uint8Array {
  const inline = () => typeof row.payload === "string" ? new TextEncoder().encode(row.payload) : new Uint8Array(row.payload)
  if (row.byte_length === null && row.chunk_count === null) return inline()
  if (!Number.isSafeInteger(row.byte_length) || row.byte_length! < 0 || !Number.isSafeInteger(row.chunk_count) || row.chunk_count! < 0 || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)) throw new RuntimeError("Invalid journal payload metadata")
  if (!row.chunk_count) {
    const bytes = inline()
    if (bytes.byteLength !== row.byte_length) throw new RuntimeError("Journal inline byte length mismatch")
    return bytes
  }
  return decodeCheckpointChunks(chunks().map(chunk => ({ ordinal: chunk.ordinal, payload: chunk.payload instanceof Uint8Array ? chunk.payload : new Uint8Array(chunk.payload) }) satisfies CheckpointChunk), row.byte_length!, row.chunk_count!)
}

export const storedPayloadDigest = (payload: Uint8Array) => createHash("sha256").update(payload).digest("hex")
