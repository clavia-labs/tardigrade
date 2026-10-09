import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Response } from "effect/unstable/ai"
import { Promises } from "@clavia/tardigrade-core"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { requestTurn } from "@clavia/tardigrade-agent/contracts/events"
import { contentServices } from "../fixtures/model-services"
import { createTestStore } from "../properties/runtime/store"

test("model usage records provider cache reads and writes", async () => {
  const usage = Response.Usage.make({ inputTokens: { total: 1_000, cacheRead: 900, cacheWrite: 80 }, outputTokens: { total: 5 } })
  const recorded = await Effect.runPromise(Effect.gen(function* () {
    const store = yield* createTestStore({ actor: createActor, actorContext, services: () => Layer.merge(
      contentServices(() => {}, { usage }),
      Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }),
    ) })
    yield* store.send([requestTurn({ text: "hello", turnId: "first", invocationRef: { method: "turn", id: "first" } })])
    yield* store.wait
    const returned = store.snapshot().events.find(event => event.type === "ModelReturned")
    yield* store.close
    return returned && "usage" in returned ? returned.usage : undefined
  }).pipe(Effect.scoped, Effect.timeout(5_000)))
  expect(recorded).toEqual({ input: 1_000, output: 5, cacheRead: 900, cacheWrite: 80, usd: null })
})
