import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { defineActor, legacyComponent } from "@clavia/tardigrade-core/actor"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { effect } from "@clavia/tardigrade-core/effect"
import { allocateRootThread } from "@clavia/tardigrade-core/actor/allocation"
import { createHost } from "./create-host"
import { serve } from "./serve"
import { connect } from "../../../packages/client/src/connect"

const message = legacyActorMethod({
  input: Schema.Struct({ text: Schema.String }), output: Schema.String,
  event: ({ invocation, input, at }) => ({ type: "MessageRequested", id: invocation.id, text: input.text, at }),
  state: (events, invocation) => {
    const done = events.find((event) => event.type === "MessageCompleted" && event.id === invocation.id)
    return done === undefined ? { status: "pending" } : { status: "completed", output: String(done.output) }
  }
})
const responder = legacyComponent({
  name: "responder",
  keys: { prefixes: ["message:"], keyOf: (event) => event.type === "MessageCompleted" ? `message:${String(event.id)}` : undefined },
  derive: (events) => ({ view: undefined, transitions: events.filter((event) => event.type === "MessageRequested").map((event) => effect({
    key: `message:${String(event.id)}`, invocation: { method: "message", id: String(event.id), epoch: 0 }, input: event, act: (input) => Effect.gen(function* () {
      if (input.text === "hold") return yield* Effect.never
      let output = input.text
      if (input.text === "relay") {
        const target = yield* allocateRootThread({ name: "tardie", methods: { message } }, { instance: "morty", name: "main" })
        output = yield* target.message({ text: "relayed" }, { key: "relay-target" })
      }
      return [{ type: "MessageCompleted", id: input.id, output }]
    }).pipe(Effect.orDie)
  })) })
})
const actor = defineActor("tardie", { message }, [responder])

test("local and HTTP references preserve allocations and results across restart", async () => {
  const storage = await mkdtemp(join(tmpdir(), "tardie-sdk-"))
  let host = await createHost({ actor, storage })
  let server: ReturnType<typeof serve> | undefined
  try {
    const rick = await host.allocateRootThread({ instance: "rick", name: "main" })
    const morty = await host.allocateRootThread({ instance: "morty", name: "main" })
    expect(await rick.message({ text: "C-137" }, { key: "portal" })).toBe("C-137")
    expect(await morty.message({ text: "school" }, { key: "portal" })).toBe("school")
    expect(await rick.message({ text: "relay" }, { key: "relay" })).toBe("relayed")
    const researcher = await host.allocateChildThread({ parent: rick.coordinate, name: "researcher" })
    expect(await researcher.message({ text: "research" }, { key: "work" })).toBe("research")
    server = serve(host, { port: 0, token: "test" })
    const endpoint = new URL("v1/actors/rick/threads/main/methods/message", server.url)
    const headers = { authorization: "Bearer test", "Content-Type": "application/json" }
    expect((await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ text: "missing key" }) })).status).toBe(400)
    const accepted = await fetch(endpoint, { method: "POST", headers: { ...headers, "Idempotency-Key": "portal" }, body: JSON.stringify({ text: "retry" }) })
    expect(accepted.status).toBe(202)
    const location = accepted.headers.get("Location")!
    expect((await fetch(new URL(location, server.url), { headers })).status).toBe(200)
    const retried = await fetch(new URL("v1/actors/rick/threads/main/methods/message/calls/portal", server.url), { method: "PUT", headers, body: JSON.stringify({ text: "retry" }) })
    expect(retried.headers.get("Location")).toBe(location)
    const remote = connect({ actor, url: server.url.href, token: "test", pollIntervalMs: 1 })
    const remoteRick = await remote.allocateRootThread({ instance: "rick", name: "main" })
    expect(await remoteRick.message({ text: "retry" }, { key: "portal" })).toBe("C-137")
    const meeseeks = await remote.allocateChildThread({ parent: researcher.coordinate, name: "meeseeks" })
    expect(await meeseeks.message({ text: "look at me" }, { key: "work" })).toBe("look at me")
    const generated = await remote.allocateRootThread({ instance: "rick", key: "stable" })
    expect((await remote.allocateRootThread({ instance: "rick", key: "stable" })).coordinate).toEqual(generated.coordinate)
    await server.close()
    server = undefined
    await host.close()
    await expect(rick.message({ text: "closed" }, { key: "closed" })).rejects.toThrow("closed")
    host = await createHost({ actor, storage })
    expect(await host.thread( meeseeks.coordinate).message({ text: "retry" }, { key: "work" })).toBe("look at me")
    expect((await host.allocateChildThread({ parent: researcher.coordinate, name: "meeseeks" })).coordinate).toEqual(meeseeks.coordinate)
  } finally {
    await server?.close()
    await host.close()
    await rm(storage, { recursive: true, force: true })
  }
}, 20000)

test("host rejects coordinates belonging to another actor", async () => {
  const host = await createHost({ actor, storage: ":memory:" })
  try {
    expect(() => host.thread({ actor: "scientist", instance: "rick", thread: "main" })).toThrow("this actor")
    await expect(host.allocateChildThread({ parent: { actor: "scientist", instance: "rick", thread: "main" } })).rejects.toThrow("same actor")
  } finally { await host.close() }
})

test("closing a host interrupts active actor work", async () => {
  const host = await createHost({ actor, storage: ":memory:" })
  const root = await host.allocateRootThread({ instance: "rick", name: "main" })
  const result = root.message({ text: "hold" }, { key: "pending" }).catch((error: unknown) => error)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await host.close()
  expect(await result).toBeInstanceOf(Error)
}, 2000)
