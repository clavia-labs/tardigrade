import { Context, Effect, type Stream } from "effect"
import { ObjectStorageError } from "./error"
export { ObjectStorageError } from "./error"
import { objectKeyOf, objectRefOf, type ObjectRef } from "./reference"
import { storeObjectStream, type ObjectStreamConfig, type ObjectStreamOptions, type ObjectUpload, type StoredObject } from "./stream"

export interface ObjectUrlOptions {
  readonly mediaType?: string
}

// ObjectStorage stores bytes by content identity and verifies retrieved content (key-value.test.ts).
export class ObjectStorage extends Context.Service<ObjectStorage, {
  readonly put: (bytes: Uint8Array) => Effect.Effect<ObjectRef, ObjectStorageError>
  readonly putStream?: <E, R>(source: Stream.Stream<Uint8Array, E, R>, options?: ObjectStreamOptions) => Effect.Effect<StoredObject, E | ObjectStorageError, R>
  readonly get: (reference: ObjectRef) => Effect.Effect<Uint8Array, ObjectStorageError>
  // url exposes an immutable object without loading bytes (platform/test/bun/model-image-url.test.ts).
  readonly url?: (reference: ObjectRef, options?: ObjectUrlOptions) => Effect.Effect<URL, ObjectStorageError>
}>()("tardigrade/ObjectStorage") {}

// makeObjectStorage adds content identity, byte isolation, and verified reads to a backend (key-value.test.ts).
export const makeObjectStorage = <E, UploadError = E>(backend: {
  readonly read: (key: string) => Effect.Effect<Uint8Array | undefined, E>
  readonly write: (key: string, bytes: Uint8Array) => Effect.Effect<void, E>
  readonly url?: (key: string, options?: ObjectUrlOptions) => Effect.Effect<URL, E>
  readonly upload?: Effect.Effect<ObjectUpload<UploadError>, UploadError>
}, streamConfig: ObjectStreamConfig = {}): typeof ObjectStorage.Service => ObjectStorage.of({
  ...(backend.upload === undefined ? {} : { putStream: <E2, R>(source: Stream.Stream<Uint8Array, E2, R>, options?: ObjectStreamOptions) => storeObjectStream(source, backend.upload!, { ...streamConfig, ...options }) }),
  ...(backend.url === undefined ? {} : { url: (reference: ObjectRef, options?: ObjectUrlOptions) => backend.url!(objectKeyOf(reference), options).pipe(
    Effect.mapError(cause => new ObjectStorageError({ reason: "Read", reference, message: "Object URL resolution failed", cause })),
  ) }),
  put: (bytes) => Effect.gen(function* () {
    const snapshot = new Uint8Array(bytes)
    const reference = yield* objectRefOf(snapshot)
    yield* backend.write(objectKeyOf(reference), snapshot).pipe(
      Effect.mapError((cause) => new ObjectStorageError({ reason: "Write", reference, message: "Object write failed", cause }))
    )
    return reference
  }),
  get: (reference) => Effect.gen(function* () {
    const bytes = yield* backend.read(objectKeyOf(reference)).pipe(
      Effect.mapError((cause) => new ObjectStorageError({ reason: "Read", reference, message: "Object read failed", cause }))
    )
    if (bytes === undefined) {
      return yield* new ObjectStorageError({ reason: "Missing", reference, message: "Object is missing" })
    }
    const snapshot = new Uint8Array(bytes)
    const actual = yield* objectRefOf(snapshot)
    if (actual.algorithm !== reference.algorithm || actual.digest !== reference.digest) {
      return yield* new ObjectStorageError({ reason: "Integrity", reference, message: "Object digest does not match its bytes" })
    }
    return snapshot
  })
})
