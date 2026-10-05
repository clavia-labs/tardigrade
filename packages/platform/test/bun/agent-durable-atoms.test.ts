import { expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Promises } from "@clavia/tardigrade-core"
import { prepareInitialState } from "@clavia/tardigrade-core/runtime/initialisation"
import { actorContext, createActor } from "@clavia/tardigrade-agent"
import { agentDurableAtoms } from "@clavia/tardigrade-agent/atoms/durable"
import { requestTurn } from "@clavia/tardigrade-agent/contracts/events"
import { contentServices } from "../fixtures/model-services"
import { createTestStore } from "../properties/runtime/store"

let prompt = ""
const services = () => Layer.merge(contentServices(value => { prompt = JSON.stringify(value) }), Layer.succeed(Promises, { watch: () => Effect.void, cancel: () => Effect.void }))

test("agent durable atoms accept the state a default agent checkpoint captures", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const source = yield* createTestStore({ actor: createActor, actorContext, services })
    yield* source.send([requestTurn({ text: "hello", turnId: "first", invocationRef: { method: "turn", id: "first" } })])
    yield* source.wait
    const captured = source.snapshot().checkpoint()!.durable
    yield* source.close
    const initialState = Object.fromEntries(captured.map(entry => [entry.name, Schema.decodeUnknownSync(Schema.Json)(entry.state)]))
    const event = yield* prepareInitialState(agentDurableAtoms, initialState)

    const target = yield* createTestStore({ actor: createActor, actorContext, services, events: [event] })
    yield* target.send([requestTurn({ text: "again", turnId: "second", invocationRef: { method: "turn", id: "second" } })])
    yield* target.wait
    const turns = target.snapshot().events.filter(event => event.type === "TurnSettled")
    yield* target.close
    expect(turns).toMatchObject([{ turnId: "second", outcome: "completed" }])
    expect(prompt).toMatch(/hello.*again/)
  }).pipe(Effect.scoped, Effect.timeout(5_000)))
})
