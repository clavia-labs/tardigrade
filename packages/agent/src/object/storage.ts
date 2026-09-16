import { Context, Data, Effect } from "effect"
import { objectKeyOf, objectRefOf, type ObjectRef } from "./reference"

// ObjectStorageError distinguishes unavailable objects, integrity failures, and backend failures.
export class ObjectStorageError extends Data.TaggedError("ObjectStorageError")<{
  readonly reason: "Unavailable" | "Missing" | "Integrity" | "Read" | "Write" | "TooLarge"
  readonly reference: ObjectRef
  readonly message: string
  readonly cause?: unknown
  readonly maxObjectBytes?: number
  readonly actualBytes?: number
}> {}

// ObjectStorage stores bytes by content identity and verifies retrieved content (key-value.test.ts).
export class ObjectStorage extends Context.Service<ObjectStorage, {
  readonly put: (bytes: Uint8Array) => Effect.Effect<ObjectRef, ObjectStorageError>
  readonly get: (reference: ObjectRef) => Effect.Effect<Uint8Array, ObjectStorageError>
}>()("tardigrade/ObjectStorage") {}

export const DEFAULT_OBJECT_READ_CONCURRENCY = 4

// ObjectReadConcurrency bounds simultaneous object reads within each model request (../inference/integration/model/objects.test.ts).
export const ObjectReadConcurrency = Context.Reference<number | "unbounded">("tardigrade/ObjectReadConcurrency", {
  defaultValue: () => DEFAULT_OBJECT_READ_CONCURRENCY
})

// makeObjectStorage adds content identity, byte isolation, and verified reads to a backend (key-value.test.ts).
export const makeObjectStorage = <E>(backend: {
  readonly read: (key: string) => Effect.Effect<Uint8Array | undefined, E>
  readonly write: (key: string, bytes: Uint8Array) => Effect.Effect<void, E>
}): typeof ObjectStorage.Service => ObjectStorage.of({
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
