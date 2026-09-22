import { Effect, Option } from "effect"
import type { AgentMessage } from "../../projection/messages"
import { objectKeyOf } from "../../object/reference"
import { ObjectReadConcurrency, ObjectStorage, ObjectStorageError } from "../../object/storage"

export type ResolvedObjects = ReadonlyMap<string, Uint8Array>

// resolveMessageObjects loads each selected object once per request (integration/model/objects.test.ts).
export const resolveMessageObjects = (messages: ReadonlyArray<AgentMessage>): Effect.Effect<ResolvedObjects, ObjectStorageError> =>
  Effect.gen(function* () {
    const references = [...new Map(messages.flatMap((message) => message.role !== "user" || typeof message.content === "string"
      ? [] : message.content.flatMap((part) => part.type === "file" ? [[objectKeyOf(part.object), part.object] as const] : []))).values()]
    if (references.length === 0) return new Map<string, Uint8Array>()
    const service = yield* Effect.serviceOption(ObjectStorage)
    if (Option.isNone(service)) {
      return yield* new ObjectStorageError({
        reason: "Unavailable", reference: references[0]!, message: "File input requires a runtime ObjectStorage service"
      })
    }
    const concurrency = yield* ObjectReadConcurrency
    if (concurrency !== "unbounded" && (!Number.isSafeInteger(concurrency) || concurrency < 1)) {
      return yield* Effect.die(new RangeError("ObjectReadConcurrency must be a positive safe integer or unbounded"))
    }
    const entries = yield* Effect.forEach(references, (reference) =>
      Effect.map(service.value.get(reference), (bytes) => [objectKeyOf(reference), bytes] as const),
    { concurrency })
    return new Map(entries)
  })
