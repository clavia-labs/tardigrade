import { RuntimeError } from "@clavia/tardigrade-core"

// CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES bounds integer ordinal and SQLite record encoding overhead (https://www.sqlite.org/fileformat.html#record_format).
export const CHECKPOINT_CHUNK_ROW_OVERHEAD_BYTES = 32
export const DEFAULT_CHECKPOINT_CHUNK_BYTES = 512 * 1024
export interface CheckpointChunkOptions { readonly checkpointChunkBytes?: number | undefined }
export interface CheckpointChunk { readonly ordinal: number; readonly payload: Uint8Array }

// validateCheckpointChunkBytes rejects write limits outside the supported SQL row capacity before storage opens (checkpointChunks).
export function validateCheckpointChunkBytes(chunkBytes: number, maxBytes?: number): void {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RuntimeError("Checkpoint chunkBytes must be a positive safe integer")
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || chunkBytes > maxBytes)) throw new RuntimeError(`Checkpoint chunkBytes exceeds the SQL host capacity of ${maxBytes} bytes`)
}

// encodeCheckpointChunks splits bytes without decoding text; concatenation preserves the input (checkpointChunks).
export function encodeCheckpointChunks(payload: Uint8Array, chunkBytes: number): readonly CheckpointChunk[] {
  validateCheckpointChunkBytes(chunkBytes)
  const chunks: CheckpointChunk[] = []
  for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) chunks.push({ ordinal: chunks.length, payload: payload.slice(offset, offset + chunkBytes) })
  return chunks
}

// decodeCheckpointChunks requires consecutive ordinals and the header's exact count and byte length (checkpointChunks).
export function decodeCheckpointChunks(chunks: readonly CheckpointChunk[], byteLength: number, chunkCount: number): Uint8Array {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || !Number.isSafeInteger(chunkCount) || chunkCount < 0 || chunks.length !== chunkCount) throw new RuntimeError("Invalid checkpoint chunk metadata")
  let size = 0
  for (const [ordinal, chunk] of chunks.entries()) {
    if (chunk.ordinal !== ordinal || !(chunk.payload instanceof Uint8Array) || !chunk.payload.byteLength) throw new RuntimeError("Invalid checkpoint chunk sequence")
    size += chunk.payload.byteLength
  }
  if (size !== byteLength) throw new RuntimeError("Checkpoint chunk byte length mismatch")
  const payload = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { payload.set(chunk.payload, offset); offset += chunk.payload.byteLength }
  return payload
}
