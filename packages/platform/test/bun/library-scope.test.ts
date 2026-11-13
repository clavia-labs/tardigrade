import { expect, test } from "bun:test"
import { mkdtemp, open, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Rpc } from "effect/rpc"
import { defineActor, ExecutionResult, type PromiseSettled } from "@clavia/tardigrade-core"
import { Library, MethodExecution } from "@clavia/tardigrade-libraries"
import { tools } from "@clavia/tardigrade-agent/atoms/tools"
import { ToolCatalog } from "@clavia/tardigrade-agent/actor/context"
import { libraryServices } from "@clavia/tardigrade-agent/services/tools"
import { createTestStore } from "../properties/runtime/store"

const reader = Library.make("reader", Rpc.make("read", {
  payload: Schema.Struct({ path: Schema.String }), success: Schema.String, error: Schema.String,
}).annotate(MethodExecution, "background"))

test("background RPC keeps its scoped file open after returning a handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tardie-library-scope-"))
  const filename = join(directory, "note.txt")
  await writeFile(filename, "still open")
  const opened = Deferred.makeUnsafe<void>()
  const returned = Deferred.makeUnsafe<void>()
  const resume = Deferred.makeUnsafe<void>()
  const settled = Deferred.makeUnsafe<PromiseSettled["result"]>()
  const implementation = Layer.succeed(reader, {
    read: ({ path }) => Effect.gen(function* () {
      const file = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => open(path, "r"), catch: String }),
        file => Effect.promise(() => file.close()),
      )
      yield* Deferred.succeed(opened, undefined)
      yield* Deferred.await(resume)
      return yield* Effect.tryPromise({ try: () => file.readFile("utf8"), catch: String })
    }),
  })
  const actor = defineActor("library-scope", Effect.map(tools([reader]), atom => ({ atom })))
  const store = await Effect.runPromise(createTestStore({
    actor, actorContext: Context.pick(ToolCatalog),
    services: () => libraryServices([reader]).pipe(Layer.provide(implementation)),
    onEvent: event => {
      if (event.type === "EffectSettled" && event.outcome.status === "fulfilled" && Schema.is(ExecutionResult)(event.outcome.value) && event.outcome.value.type === "promise") Effect.runSync(Deferred.succeed(returned, undefined))
      if (event.type === "PromiseSettled") Effect.runSync(Deferred.succeed(settled, event.result))
    },
  }))
  try {
    await Effect.runPromise(store.send([{ type: "ModelReturned", purpose: "inference", callId: "model", text: "", toolCalls: [
      { callId: "read", providerId: "provider", name: "reader__read", input: { path: filename } },
    ] }]))
    await Effect.runPromise(Effect.all([Deferred.await(opened), Deferred.await(returned)]).pipe(Effect.timeout(2_000)))
    await Effect.runPromise(Deferred.succeed(resume, undefined))
    const result = await Effect.runPromise(Deferred.await(settled).pipe(Effect.timeout(2_000)))
    expect(result).toEqual({ status: "fulfilled", value: { content: [{ type: "text", text: '"still open"' }] } })
  } finally {
    await Effect.runPromise(Deferred.succeed(resume, undefined))
    await Effect.runPromise(store.close)
    await rm(directory, { recursive: true, force: true })
  }
})
