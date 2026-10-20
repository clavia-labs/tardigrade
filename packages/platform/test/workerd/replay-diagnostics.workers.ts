import { expect, test } from "vitest"
import { Context, Effect, Layer, Logger, References, Schema } from "effect"
import { ActorReplayError, actorMethod, createActorStore, defineActor, durableAtom, effectAtom, event } from "@clavia/tardigrade-core"
import { cloudflareHandler, type HttpHost } from "../../src/cloudflare"

test("Cloudflare HTTP logs native aggregate decoder evidence and returns a fixed replay response", async () => {
  const Received = event({ type: "BuilderRevisionRequested", value: Schema.String })
  const value = durableAtom({ name: "replay.value", input: Received, schema: Schema.String, initial: "", reduce: (_, event) => event.value })
  const actor = defineActor("replay", Effect.succeed({
    atom: effectAtom(get => ({ view: get(value), events: {}, acts: {} })),
    methods: { receive: actorMethod({ inputSchema: Schema.String, outputSchema: Schema.String, onReceive: Received.from(value => ({ value })), result: () => undefined }) },
  }))
  const create = createActorStore({ actor, events: [{ type: "BuilderRevisionRequested", value: "valid", model: "synthetic-private-prompt" } as typeof Received.Type], inspect: true, actorContext: Context.pick(), services: () => Layer.empty })
  const host: HttpHost = {
    actor: "replay", allocateRootThread: () => create.pipe(Effect.flatMap(store => store.close), Effect.andThen(Effect.die("Expected incompatible history"))),
    allocateChildThread: () => Effect.die("Unused"), getThread: () => Effect.die("Unused"), send: () => Effect.die("Unused"),
  }
  const fields: Array<Readonly<Record<string, unknown>>> = []
  const logger = Logger.make(options => { fields.push(options.fiber.getRef(References.CurrentLogAnnotations)) })
  const handler = cloudflareHandler(host)
  try {
    const response = await handler.handler(new Request("https://example.test/v1/actors/main/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), Context.make(Logger.CurrentLoggers, new Set([logger])))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ code: "actor_replay_failed", message: "Actor history could not be replayed" })
    expect(fields).toHaveLength(1)
    expect(fields[0]).toMatchObject({ errorName: "ActorReplayError", errorCode: "actor_replay_failed", errorStage: "event", errorReason: "decode_failed", errorPosition: 0 })
    expect(JSON.stringify(fields)).toContain("model")
    expect(JSON.stringify(fields)).toContain("Expected no excess property")
  } finally { await handler.dispose() }
})

test("missing retained input stays distinguishable without exposing its private cause", async () => {
  const error = new ActorReplayError({ stage: "retained_input", reason: "unavailable", position: 4, cause: new Error("synthetic-private-input") })
  expect(error.reason).toBe("unavailable")
  const handler = cloudflareHandler({ actor: "replay", allocateRootThread: () => Effect.fail(error), allocateChildThread: () => Effect.die("Unused"), getThread: () => Effect.die("Unused"), send: () => Effect.die("Unused") })
  try {
    const response = await handler.handler(new Request("https://example.test/v1/actors/main/threads", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }))
    expect(await response.text()).toBe(JSON.stringify({ code: "actor_replay_failed", message: "Actor history could not be replayed" }))
  } finally { await handler.dispose() }
})
