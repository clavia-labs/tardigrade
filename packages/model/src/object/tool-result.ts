import { Data, Effect, Option, Schema } from "effect"
import { ToolResult, StoredToolResult } from "./content"
import { ObjectStorage } from "./storage"

export class ToolResultError extends Data.TaggedError("ToolResultError")<{ readonly message: string }> {}

// persistToolResult translates tool content before it crosses a durable JSON boundary (packages/platform/test/workerd/agent-content.workers.ts).
export const persistToolResult = (value: unknown): Effect.Effect<Schema.Json, Error> => Effect.gen(function* () {
  const result = yield* Schema.decodeUnknownEffect(Schema.Union([Schema.toType(ToolResult), ToolResult]), { onExcessProperty: "error" })(value)
  const hasBytes = result.content.some(part => part.type === "file" && "bytes" in part)
  if (!hasBytes) return yield* Schema.encodeUnknownEffect(StoredToolResult)(result)
  const storage = yield* Effect.serviceOption(ObjectStorage)
  if (Option.isNone(storage)) return yield* new ToolResultError({ message: "Tool file output requires a runtime ObjectStorage service" })
  const content = yield* ObjectStorage.persist(result.content).pipe(Effect.provideService(ObjectStorage, storage.value))
  return yield* Schema.encodeUnknownEffect(StoredToolResult)({ content })
})
