import { Effect, Layer, Schema } from "effect"
import { ClusterSchema, Entity, TestRunner } from "effect/cluster"
import { Rpc } from "effect/rpc"
import { createMethodClient } from "@clavia/tardigrade-platform/client"
import { RuntimeError } from "@clavia/tardigrade-core"
import { actor } from "./agents/inbox"

export const ClusterInbox = Entity.make("RemoteInbox", [Rpc.make("Send", {
  payload: { id: Schema.NonEmptyString, text: Schema.String },
  success: Schema.String, error: Schema.String,
  primaryKey: payload => JSON.stringify([payload.id, payload.text]),
})]).annotateRpcs(ClusterSchema.Persisted, true)

// clusterInboxLayer addresses a DO-hosted inbox from a Cluster entity (platform/test/workerd/cluster-client.workers.ts).
export function clusterInboxLayer(options: { readonly url: string; readonly thread: string; readonly token?: string }) {
  return ClusterInbox.toLayer(Effect.gen(function* () {
    const address = yield* Entity.CurrentAddress
    const { methods } = yield* actor.inspect.pipe(Effect.orDie)
    const client = createMethodClient({ ...options, instance: address.entityId, methods, fetch: request => fetch(request) })
    return { Send: ({ payload }) => Effect.gen(function* () {
      yield* client.createThread()
      const call = yield* client.invoke("message", { text: payload.text }, { id: payload.id })
      yield* Effect.log(`DO accepted message ${call.id}`)
      const result = yield* client.wait("message", call.id)
      if (result.status !== "completed") return yield* Effect.fail(new RuntimeError(JSON.stringify(result)))
      return result.output
    }).pipe(Effect.mapError(String)) }
  }))
}

if (import.meta.main) {
  const [url] = Bun.argv.slice(2)
  if (!url) throw new Error("Usage: bun run packages/examples/cluster.ts URL")
  const token = process.env.TARDIGRADE_TOKEN
  const program = Effect.gen(function* () {
    const inbox = (yield* ClusterInbox.client)("main")
    const message = { id: "hello-1", text: "Hello from Cluster" }
    yield* Effect.log("Cluster sends hello-1 to the DO-hosted inbox")
    yield* Effect.log(`DO result: ${yield* inbox.Send(message)}`)
    yield* Effect.log(`Same message ID again: ${yield* inbox.Send(message)}`)
  })
  await Effect.runPromise(program.pipe(Effect.provide(clusterInboxLayer({ url, thread: "inbox", ...(token === undefined ? {} : { token }) }).pipe(Layer.provideMerge(TestRunner.layer)))))
}
