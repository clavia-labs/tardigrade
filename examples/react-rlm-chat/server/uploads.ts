import { Effect } from "effect"
import type { ObjectStorage } from "tardie/agent"

export const DEFAULT_MAX_UPLOAD_BYTES = 10_000_000
const UPLOAD_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf"] as const

export const uploadLimit = (value?: string): number => {
  const limit = value === undefined ? DEFAULT_MAX_UPLOAD_BYTES : Number(value)
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("CHAT_MAX_UPLOAD_BYTES must be a positive integer")
  return limit
}

// uploadResponse bounds buffered bytes and persists uploads before returning references (uploads.test.ts).
export const uploadResponse = async (request: Request, storage: typeof ObjectStorage.Service, options: {
  readonly maxUploadBytes: number
}): Promise<Response> => {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "Content-Type, Authorization", "cache-control": "no-store" }
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers })
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers })
  if (request.method === "GET") return json({ maxUploadBytes: options.maxUploadBytes, mediaTypes: UPLOAD_MEDIA_TYPES })
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim()
  if (!UPLOAD_MEDIA_TYPES.some(type => type === mediaType)) return json({ error: "Choose a PNG, JPEG, WebP, GIF, or PDF file" }, 415)
  const tooLarge = () => json({ error: `File exceeds the ${options.maxUploadBytes} byte upload limit`, maxUploadBytes: options.maxUploadBytes }, 413)
  if (Number(request.headers.get("content-length")) > options.maxUploadBytes) return tooLarge()
  if (request.body === null) return json({ error: "File is empty" }, 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > options.maxUploadBytes) {
        await reader.cancel()
        return tooLarge()
      }
      chunks.push(chunk.value)
    }
    if (size === 0) return json({ error: "File is empty" }, 400)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
    const object = await Effect.runPromise(storage.put(bytes))
    return json({ object }, 201)
  } catch {
    return json({ error: "Upload failed; please retry" }, 503)
  } finally {
    reader.releaseLock()
  }
}
