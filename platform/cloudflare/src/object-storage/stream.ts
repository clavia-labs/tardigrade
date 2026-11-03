import { Effect } from "effect"
import { objectKeyOf, objectUploadId, ObjectStorageError, type ObjectUpload } from "@clavia/tardigrade-store"

export const R2_MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024
export const R2_MAX_MULTIPART_PARTS = 10_000
// R2_MAX_UPLOAD_BYTES follows the per-request limit at https://developers.cloudflare.com/r2/platform/limits/#footnotes.
export const R2_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024
export const DEFAULT_R2_MULTIPART_PART_BYTES = 5 * 1024 * 1024
export const DEFAULT_R2_STAGING_PREFIX = ".uploads/"

export interface R2ObjectStreamOptions {
  readonly multipartPartBytes?: number
  readonly maxMultipartParts?: number
  readonly stagingPrefix?: string
}

export type R2ObjectStreamBucket = Pick<R2Bucket, "get" | "put" | "delete" | "createMultipartUpload">

// r2ObjectUpload stages parts before publishing the complete digest key (test/objects.workers.ts).
export function r2ObjectUpload(bucket: R2ObjectStreamBucket, prefix: string, options: R2ObjectStreamOptions = {}) {
  const partBytes = options.multipartPartBytes ?? DEFAULT_R2_MULTIPART_PART_BYTES
  const maxParts = options.maxMultipartParts ?? R2_MAX_MULTIPART_PARTS
  const stagingPrefix = options.stagingPrefix ?? DEFAULT_R2_STAGING_PREFIX
  // R2 multipart constraints are defined at https://developers.cloudflare.com/r2/objects/upload-objects/.
  if (!Number.isSafeInteger(partBytes) || partBytes < R2_MIN_MULTIPART_PART_BYTES || partBytes > R2_MAX_UPLOAD_BYTES) throw new RangeError(`multipartPartBytes must be between ${R2_MIN_MULTIPART_PART_BYTES} and ${R2_MAX_UPLOAD_BYTES}`)
  if (!Number.isSafeInteger(maxParts) || maxParts < 1 || maxParts > R2_MAX_MULTIPART_PARTS) throw new RangeError(`maxMultipartParts must be between 1 and ${R2_MAX_MULTIPART_PARTS}`)
  if (!stagingPrefix || stagingPrefix.startsWith("sha256:")) throw new RangeError("stagingPrefix must be nonempty and outside the digest key space")
  const attempt = <A>(run: () => Promise<A>, message = "R2 stream operation failed") => Effect.tryPromise({
    try: run, catch: cause => new ObjectStorageError({ reason: "Write", message, cause }),
  })
  return Effect.gen(function* () {
    const key = `${prefix}${stagingPrefix}${yield* objectUploadId}`
    const buffer = new Uint8Array(partBytes)
    const multipart = yield* attempt(() => bucket.createMultipartUpload(key))
    let length = 0
    let settled = false
    let byteSize = 0
    const parts: R2UploadedPart[] = []
    const flush = () => Effect.gen(function* () {
      if (parts.length >= maxParts) return yield* new ObjectStorageError({ reason: "Write", message: `R2 upload exceeds maxMultipartParts ${maxParts}` })
      const bytes = buffer.slice(0, length)
      const part = yield* attempt(() => multipart.uploadPart(parts.length + 1, bytes))
      parts.push(part)
      length = 0
    })
    return {
      write: bytes => Effect.gen(function* () {
        if (bytes.byteLength > R2_MAX_UPLOAD_BYTES - byteSize) return yield* new ObjectStorageError({ reason: "TooLarge", maxObjectBytes: R2_MAX_UPLOAD_BYTES, actualBytes: byteSize + bytes.byteLength, message: `R2 staged publication exceeds ${R2_MAX_UPLOAD_BYTES} bytes` })
        byteSize += bytes.byteLength
        for (let offset = 0; offset < bytes.byteLength;) {
          const count = Math.min(partBytes - length, bytes.byteLength - offset)
          buffer.set(bytes.subarray(offset, offset + count), length)
          offset += count
          length += count
          if (length === partBytes) yield* flush()
        }
      }),
      commit: result => Effect.gen(function* () {
        const destination = prefix + objectKeyOf(result.object)
        if (result.byteSize === 0) {
          yield* attempt(() => multipart.abort())
          settled = true
          const object = yield* attempt(() => bucket.put(destination, new Uint8Array()))
          if (!object || object.size !== 0) return yield* new ObjectStorageError({ reason: "Write", message: "R2 did not acknowledge the empty object write" })
          return
        }
        if (length) yield* flush()
        yield* attempt(() => multipart.complete(parts))
        settled = true
        const object = yield* attempt(() => bucket.get(key))
        if (!object || object.size !== result.byteSize) return yield* new ObjectStorageError({ reason: "Write", message: "R2 staging object is missing or has a different byte size" })
        const published = yield* attempt(() => bucket.put(destination, object.body))
        if (!published || published.size !== result.byteSize) return yield* new ObjectStorageError({ reason: "Write", message: "R2 did not acknowledge the complete object write" })
      }),
      abort: Effect.suspend(() => settled ? Effect.void : attempt(() => multipart.abort())).pipe(
        Effect.ensuring(attempt(() => bucket.delete(key), "R2 staging cleanup failed").pipe(Effect.orDie)),
      ),
    } satisfies ObjectUpload<ObjectStorageError>
  })
}
