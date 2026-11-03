import { Effect, Random, Stream } from "effect"
import { ObjectStorageError } from "./error"
import type { ObjectRef } from "./reference"

export interface StoredObject {
  readonly object: ObjectRef
  readonly byteSize: number
}

export interface ObjectStreamOptions {
  readonly maxObjectBytes?: number
}

export const DEFAULT_MAX_STREAM_OBJECT_BYTES = Number.MAX_SAFE_INTEGER
export const DEFAULT_OBJECT_STREAM_CHUNK_BYTES = 64 * 1024

// objectUploadId supplies nonsecret identifiers for isolated staging resources.
export const objectUploadId = Effect.all([Random.nextInt, Random.nextInt, Random.nextInt, Random.nextInt]).pipe(Effect.map(parts => parts.map(value => (value >>> 0).toString(16).padStart(8, "0")).join("")))

export interface ObjectUpload<E> {
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, E>
  readonly commit: (object: StoredObject) => Effect.Effect<void, E>
  // abort releases staging state after every exit, including successful commits.
  readonly abort: Effect.Effect<void, E>
}

export interface ObjectStreamConfig extends ObjectStreamOptions {
  readonly chunkBytes?: number
}

// objectStreamConfig validates the byte bounds applied before an upload is acquired.
export function objectStreamConfig(config: ObjectStreamConfig = {}) {
  const maxObjectBytes = config.maxObjectBytes ?? DEFAULT_MAX_STREAM_OBJECT_BYTES
  const chunkBytes = config.chunkBytes ?? DEFAULT_OBJECT_STREAM_CHUNK_BYTES
  if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 0) throw new RangeError("maxObjectBytes must be a nonnegative safe integer")
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) throw new RangeError("chunkBytes must be a positive safe integer")
  return { maxObjectBytes, chunkBytes }
}

// storeObjectStream writes content-addressed objects through scoped staging resources.
export function storeObjectStream<SourceError, Services, UploadError>(source: Stream.Stream<Uint8Array, SourceError, Services>, acquire: Effect.Effect<ObjectUpload<UploadError>, UploadError>, config: ObjectStreamConfig = {}): Effect.Effect<StoredObject, SourceError | ObjectStorageError, Services> {
  return Effect.scoped(Effect.gen(function* () {
    const policy = yield* Effect.try({ try: () => objectStreamConfig(config), catch: cause => new ObjectStorageError({ reason: "Write", message: "Invalid object stream policy", cause }) })
    const failure = (cause: UploadError) => cause instanceof ObjectStorageError ? cause : new ObjectStorageError({ reason: "Write", message: "Object stream upload failed", cause })
    const { createHash } = yield* Effect.tryPromise({ try: () => import("node:crypto"), catch: cause => new ObjectStorageError({ reason: "Unavailable", message: "Incremental SHA-256 requires node:crypto support", cause }) })
    const hash = yield* Effect.acquireRelease(Effect.sync(() => createHash("sha256")), hash => Effect.sync(() => { hash.destroy() }))
    const upload = yield* Effect.acquireRelease(acquire.pipe(Effect.mapError(failure)), upload => upload.abort.pipe(Effect.mapError(failure), Effect.orDie))
    let byteSize = 0
    yield* Stream.runForEach(source, input => Effect.gen(function* () {
      if (input.byteLength > policy.maxObjectBytes - byteSize) return yield* new ObjectStorageError({ reason: "TooLarge", actualBytes: byteSize + input.byteLength, maxObjectBytes: policy.maxObjectBytes, message: `Object stream exceeds ${policy.maxObjectBytes} bytes` })
      for (let offset = 0; offset < input.byteLength; offset += policy.chunkBytes) {
        const bytes = input.slice(offset, offset + policy.chunkBytes)
        hash.update(bytes)
        byteSize += bytes.byteLength
        yield* upload.write(bytes).pipe(Effect.mapError(failure))
      }
    }))
    const object: ObjectRef = { algorithm: "sha256", digest: hash.digest("hex") }
    const result = { object, byteSize }
    yield* upload.commit(result).pipe(Effect.mapError(failure), Effect.uninterruptible)
    return result
  }))
}
