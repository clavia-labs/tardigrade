import { ToolError } from "./errors"
import { Context, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { defineLibrary, MethodDescription, MethodHints } from "./library"

export class Workspace extends Context.Service<Workspace, {
  readonly read: (key: string) => Effect.Effect<string | null, Error>
  readonly write: (key: string, value: string) => Effect.Effect<void, Error>
  readonly keys: Effect.Effect<readonly string[], Error>
}>()("tardigrade/experimental/packages/Workspace") {}

export const DEFAULT_WORKSPACE_POLICY = { maxChars: 32_768, maxEntries: 100 } as const

// memoryWorkspace allocates an ephemeral key/value workspace per layer construction.
export const memoryWorkspace = Layer.effect(Workspace, Effect.sync(() => {
  const values = new Map<string, string>()
  return {
    read: (key: string) => Effect.sync(() => values.get(key) ?? null),
    write: (key: string, value: string) => Effect.sync(() => { values.set(key, value) }),
    keys: Effect.sync(() => [...values.keys()].sort()),
  }
}))

// workspace exposes bounded reads and key listings over caller-supplied storage.
export function workspace(options: { readonly maxChars?: number; readonly maxEntries?: number } = {}) {
  const maxChars = options.maxChars ?? DEFAULT_WORKSPACE_POLICY.maxChars
  const maxEntries = options.maxEntries ?? DEFAULT_WORKSPACE_POLICY.maxEntries
  if (![maxChars, maxEntries].every(value => Number.isSafeInteger(value) && value > 0)) throw new ToolError("Workspace limits must be positive integers")
  const library = defineLibrary({
    toolNames: { write: "write_text", read: "read_text", list: "list_texts" },
    name: "workspace", description: "Read and write named text values in the agent workspace.",
    methods: [
      Rpc.make("write", { payload: Schema.Struct({ key: Schema.String, value: Schema.String }),
        success: Schema.Struct({ key: Schema.String, chars: Schema.Finite }), error: Schema.String,
      }).annotate(MethodDescription, "Store a text value by key, replacing any existing value.")
        .annotate(MethodHints, { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false }),
      Rpc.make("read", { payload: Schema.Struct({ key: Schema.String, offset: Schema.optionalKey(Schema.Finite) }),
        success: Schema.Struct({ key: Schema.String, value: Schema.String, offset: Schema.Finite, totalChars: Schema.Finite, truncated: Schema.Boolean, maxChars: Schema.Finite }), error: Schema.String,
      }).annotate(MethodDescription, `Read up to ${maxChars} characters from a key, optionally starting at offset.`)
        .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
      Rpc.make("list", { payload: Schema.Struct({ after: Schema.optionalKey(Schema.String) }),
        success: Schema.Struct({ keys: Schema.Array(Schema.String), truncated: Schema.Boolean, next: Schema.NullOr(Schema.String), maxEntries: Schema.Finite }), error: Schema.String,
      }).annotate(MethodDescription, `List up to ${maxEntries} workspace keys after an optional key cursor.`)
        .annotate(MethodHints, { readOnlyHint: true, openWorldHint: false }),
    ],
  })
  return library.implement({
    write: ({ key, value }) => Effect.gen(function* () {
      const store = yield* Workspace
      yield* store.write(key, value)
      return { key, chars: value.length }
    }).pipe(Effect.mapError(String)),
    read: ({ key, offset = 0 }) => Effect.gen(function* () {
      if (!Number.isSafeInteger(offset) || offset < 0) return yield* Effect.fail(new ToolError("offset must be a nonnegative integer"))
      const store = yield* Workspace
      const value = yield* store.read(key)
      if (value === null) return yield* Effect.fail(new ToolError(`Unknown workspace key: ${key}`))
      return { key, value: value.slice(offset, offset + maxChars), offset, totalChars: value.length, truncated: offset + maxChars < value.length, maxChars }
    }).pipe(Effect.mapError(String)),
    list: ({ after }) => Effect.gen(function* () {
      const store = yield* Workspace
      const keys = [...yield* store.keys].sort().filter(key => after === undefined || key > after)
      const page = keys.slice(0, maxEntries)
      return { keys: page, truncated: keys.length > maxEntries, next: keys.length > maxEntries ? page.at(-1)! : null, maxEntries }
    }).pipe(Effect.mapError(String)),
  })
}
