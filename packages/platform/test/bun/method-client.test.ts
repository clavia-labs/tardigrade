import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, event } from "@clavia/tardigrade-core"
import { createBunHost, methodHttp } from "../../src/bun"
import { createMethodClient } from "@clavia/tardigrade-client"

test("method clients retain pending calls after local deadlines and cancel explicitly", async () => {
  const Requested = event({ type: "Requested", id: Schema.String })
  const Cancelled = event({ type: "Cancelled", id: Schema.String, reason: Schema.String })
  const cancelled = durableAtom({ name: "client.cancelled", input: Cancelled, schema: Schema.Record(Schema.String, Schema.String), initial: {}, reduce: (state, e) => ({ ...state, [e.id]: e.reason }) })
  const actor = defineActor("client", Effect.succeed({ atom: cancelled, methods: {
    run: actorMethod({ inputSchema: Schema.Null, outputSchema: Schema.String,
      onReceive: Requested.from((_, context) => ({ id: context.id })),
      onCancel: Cancelled.from((_, context) => ({ id: context.id, reason: context.reason })),
      result: (_, get, context) => { const reason = get(cancelled)[context.id]; return reason === undefined ? undefined : { status: "cancelled", reason } },
    }),
  } }))
  const storage = await mkdtemp(join(tmpdir(), "tardie-method-client-"))
  const host = await Effect.runPromise(createBunHost({ actor, storage, actorContext: Context.pick(), services: () => Layer.empty }))
  const { methods } = await Effect.runPromise(actor.inspect)
  const client = createMethodClient({ url: "http://test/", instance: "instance /?", thread: "thread ?", methods, fetch: methodHttp(host, { token: "secret" }), token: "secret", policy: { pollIntervalMs: 1, resultTimeoutMs: 20 } })
  try {
    expect(await Effect.runPromise(client.createThread())).toEqual({ actor: "client", instance: "instance /?", thread: "thread ?" })
    const call = await Effect.runPromise(client.invoke("run", null, { id: "call /?" }))
    expect(call).toEqual({ instance: "instance /?", thread: "thread ?", method: "run", id: "call /?" })
    await expect(Effect.runPromise(client.wait("run", call.id))).rejects.toThrow()
    expect(await Effect.runPromise(client.result("run", call.id))).toEqual({ status: "pending" })
    await Effect.runPromise(client.cancel("run", call.id, "stop"))
    await Effect.runPromise(client.cancel("run", call.id, "stop"))
    expect(await Effect.runPromise(client.wait("run", call.id))).toEqual({ status: "cancelled", reason: "stop" })
    const ref = await Effect.runPromise(host.getThread({ instance: "instance /?", thread: "thread ?" }))
    expect((await Effect.runPromise(ref!.records())).filter(record => record.event.type === "MessageReceived")).toHaveLength(2)
  } finally { await Effect.runPromise(host.close); await rm(storage, { recursive: true, force: true }) }
})
