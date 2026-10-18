import { GroveError } from "../../session/reader"

export interface NodeChunk { readonly inline: string | Uint8Array | ArrayBuffer | null; readonly ordinal: number | null; readonly payload: string | Uint8Array | ArrayBuffer | null; readonly byte_length: number; readonly chunk_count: number }

const utf8 = (value: Uint8Array | ArrayBuffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value)
// decodeNodeChunks verifies a complete UTF-8 node, stored inline or in ordered chunks as text or bytes, before the reader authenticates its hash (test/transactions.test.ts).
export const decodeNodeChunks = (rows: readonly NodeChunk[]): string => {
  const first = rows[0]
  if (first?.inline) {
    const text = typeof first.inline === "string" ? first.inline : utf8(first.inline)
    if (rows.length !== 1 || first.chunk_count !== 1 || Buffer.byteLength(text, "utf8") !== first.byte_length) throw new GroveError({ message: "Node length mismatch" })
    return text
  }
  if (!first || rows.length !== first.chunk_count || !Number.isSafeInteger(first.byte_length) || first.byte_length < 1 || rows.some(row => !row.payload)) throw new GroveError({ message: "Node chunks missing or invalid" })
  if (rows.every(row => typeof row.payload === "string")) {
    for (const [index, row] of rows.entries()) if (row.ordinal !== index) throw new GroveError({ message: "Node chunks invalid" })
    const text = rows.map(row => row.payload as string).join("")
    if (Buffer.byteLength(text, "utf8") !== first.byte_length) throw new GroveError({ message: "Node length mismatch" })
    return text
  }
  const payload = new Uint8Array(first.byte_length)
  let offset = 0
  for (const [index, row] of rows.entries()) {
    const chunk = typeof row.payload === "string" ? new TextEncoder().encode(row.payload) : row.payload instanceof ArrayBuffer ? new Uint8Array(row.payload) : row.payload as Uint8Array
    if (row.ordinal !== index || offset + chunk.byteLength > payload.byteLength) throw new GroveError({ message: "Node chunks invalid" })
    payload.set(chunk, offset); offset += chunk.byteLength
  }
  if (offset !== payload.byteLength) throw new GroveError({ message: "Node length mismatch" })
  return utf8(payload)
}

// textChunks preserves UTF-8 boundaries and uses bytes for leading U+FEFF or U+FFFE chunks because Bun strips those characters from bound strings (test/transactions.test.ts).
export const textChunks = (text: string, chunkBytes: number): readonly (string | Uint8Array)[] => {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new Error("chunkBytes must be a positive safe integer")
  if (chunkBytes < 4) {
    const bytes = new TextEncoder().encode(text), pieces: Uint8Array[] = []
    for (let start = 0; start < bytes.length; start += chunkBytes) pieces.push(bytes.subarray(start, start + chunkBytes))
    return pieces
  }
  const pieces: (string | Uint8Array)[] = []
  for (let start = 0; start < text.length;) {
    const boundary = (end: number) => {
      const code = text.charCodeAt(end - 1)
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--
      return end > start ? end : start + 2
    }
    let end = boundary(Math.min(text.length, start + chunkBytes))
    for (let bytes = Buffer.byteLength(text.slice(start, end), "utf8"); bytes > chunkBytes; bytes = Buffer.byteLength(text.slice(start, end), "utf8")) end = boundary(start + Math.max(1, Math.floor((end - start) * chunkBytes / bytes)))
    const piece = text.slice(start, end)
    pieces.push((piece.charCodeAt(0) === 0xfeff || piece.charCodeAt(0) === 0xfffe) ? new TextEncoder().encode(piece) : piece); start = end
  }
  return pieces
}

// NODE_QUERY returns the inline payload, or the chunk rows of a node larger than one chunk.
export const NODE_QUERY = "SELECT n.payload AS inline, c.ordinal, c.payload, n.byte_length, n.chunk_count FROM grove_value_nodes n LEFT JOIN grove_value_chunks c ON n.payload IS NULL AND c.hash = n.hash WHERE n.hash = ? ORDER BY c.ordinal"
const DIGEST_BYTES = 32
export const packDigests = (hashes: readonly string[]) => {
  const packed = new Uint8Array(hashes.length * DIGEST_BYTES)
  hashes.forEach((hash, index) => { for (let i = 0; i < DIGEST_BYTES; i++) packed[index * DIGEST_BYTES + i] = parseInt(hash.slice(i * 2, i * 2 + 2), 16) })
  return packed
}
export const unpackDigests = (packed: Uint8Array) => Array.from({ length: packed.byteLength / DIGEST_BYTES }, (_, index) => Array.from(packed.subarray(index * DIGEST_BYTES, (index + 1) * DIGEST_BYTES), byte => byte.toString(16).padStart(2, "0")).join(""))

export const DEFAULT_CHUNK_BYTES = 128 * 1024
// DEFAULT_MAX_PARAMETERS matches the bound-parameter limit of Durable Object SQLite; node writes batch rows up to it.
export const DEFAULT_MAX_PARAMETERS = 100
