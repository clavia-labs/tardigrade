import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { actorMethod, defineActor, durableAtom, event } from "@clavia/tardigrade-core"
import { createBunHost, methodHttp } from "../../src/bun"
import { createMethodClient, MethodClientHttpError } from "../../src/client"

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

const methods = { add: { inputSchema: Schema.Int, outputSchema: Schema.Int } }
const options = { url: "http://test", instance: "main", thread: "one", methods }

test("method clients reject mismatched identities and malformed outputs", async () => {
  for (const body of [
    { id: "different", method: "add", status: "completed", output: 1 },
    { id: "same", method: "different", status: "completed", output: 1 },
    { id: "same", method: "add", status: "completed", output: "wrong" },
    { id: "same", method: "add", status: "unexpected" },
  ]) {
    const client = createMethodClient({ ...options, fetch: async () => Response.json(body) })
    await expect(Effect.runPromise(client.result("add", "same"))).rejects.toThrow()
  }
  const client = createMethodClient({ ...options, fetch: async () => Response.json({ actor: "other", thread: "one", method: "add", id: "same" }, { status: 202 }) })
  await expect(Effect.runPromise(client.invoke("add", 1, { id: "same" }))).rejects.toThrow("different call")
})

test("method clients expose HTTP errors and leave retry decisions with the caller", async () => {
  let requests = 0
  const client = createMethodClient({ ...options, fetch: async () => { requests++; return new Response("conflict", { status: 409 }) } })
  const operations = [Effect.asVoid(client.invoke("add", 1, { id: "same" })), Effect.asVoid(client.result("add", "same")), Effect.asVoid(client.wait("add", "same"))]
  for (const work of operations) {
    const failure = await Effect.runPromise(Effect.flip(work))
    expect(failure).toBeInstanceOf(MethodClientHttpError)
    if (failure instanceof MethodClientHttpError) expect(failure.status).toBe(409)
  }
  expect(requests).toBe(3)
  await expect(Effect.runPromise(client.invoke("add", 1.5, { id: "invalid" }))).rejects.toThrow()
  await expect(Effect.runPromise(client.invoke("add", 1, { id: " " }))).rejects.toThrow()
  await expect(Effect.runPromise(client.invoke("add", 1, { id: " same " }))).rejects.toThrow()
  expect(requests).toBe(3)
})

test("request deadlines abort the local fetch and cover response decoding", async () => {
  let aborted = false
  const client = createMethodClient({ ...options, policy: { requestTimeoutMs: 10 }, fetch: request => new Promise((_resolve, reject) => {
    request.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")) }, { once: true })
  }) })
  await expect(Effect.runPromise(client.result("add", "same"))).rejects.toThrow()
  expect(aborted).toBe(true)
  const stalledBody = createMethodClient({ ...options, policy: { requestTimeoutMs: 10 }, fetch: async () => new Response(new ReadableStream({ start() {} })) })
  await expect(Effect.runPromise(stalledBody.result("add", "same"))).rejects.toThrow()
})
