import { Context, Effect } from "effect"
import { ObjectStorage, ObjectStorageError, objectKeyOf } from "@clavia/tardigrade-store"
import type { ContentPart, InputContentPart, ResolvedContentPart } from "./content"

// persistContent translates incoming content into parts suitable for the event log.
export function persistContent(content: readonly InputContentPart[]): Effect.Effect<readonly ContentPart[], ObjectStorageError, ObjectStorage> {
  return Effect.gen(function* () {
    const storage = yield* ObjectStorage
    return yield* Effect.forEach(content, (part): Effect.Effect<ContentPart, ObjectStorageError> => {
      if (part.type === "text") return Effect.succeed({ type: "text" as const, text: part.text })
      const byteSize = "object" in part ? part.byteSize : part.bytes.byteLength
      const reference = "object" in part ? Effect.succeed(part.object) : storage.put(part.bytes)
      return reference.pipe(Effect.map(object => ({
        type: "file" as const, mediaType: part.mediaType,
        ...(byteSize === undefined ? {} : { byteSize }),
        ...(part.filename === undefined ? {} : { filename: part.filename }), object,
      })))
    })
  })
}

// resolveContent translates stored content into parts containing file bytes.
export function resolveContent(content: readonly ContentPart[]): Effect.Effect<readonly ResolvedContentPart[], ObjectStorageError, ObjectStorage> {
  return Effect.gen(function* () {
    const storage = yield* ObjectStorage
    const references = new Map(content.flatMap(part => part.type === "file" ? [[objectKeyOf(part.object), part.object] as const] : []))
    const concurrency = yield* ObjectReadConcurrency
    if (concurrency !== "unbounded" && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
      return yield* Effect.die(new RangeError("ObjectReadConcurrency must be a positive safe integer or unbounded"))
    }
    const entries = yield* Effect.forEach(references.values(), reference => storage.get(reference).pipe(
      Effect.map(bytes => [objectKeyOf(reference), bytes] as const),
    ), { concurrency })
    const objects = new Map(entries)
    return content.map(part => {
      if (part.type === "text") return part
      const bytes = objects.get(objectKeyOf(part.object))
      if (bytes === undefined) throw new Error(`Unresolved object: ${objectKeyOf(part.object)}`)
      return { type: "file" as const, mediaType: part.mediaType,
        ...(part.filename === undefined ? {} : { filename: part.filename }), byteSize: bytes.byteLength, bytes: new Uint8Array(bytes) }
    })
  })
}

export const DEFAULT_OBJECT_READ_CONCURRENCY = 4

// ObjectReadConcurrency configures simultaneous reads during content resolution.
export const ObjectReadConcurrency = Context.Reference<number | "unbounded">("tardigrade/ObjectReadConcurrency", {
  defaultValue: () => DEFAULT_OBJECT_READ_CONCURRENCY
})
