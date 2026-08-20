import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { Infer, type InferRequest } from "@clavia/tardigrade"
import type { Action } from "@clavia/tardigrade/events"

import { layerConfig, readConfig } from "./config"
import { Agents, layerAgents, ResumeRefused } from "./host"
import { DriverGauge } from "./http"

// The host service against a real durable host on a volatile database, with the model seam bound
// to a scripted mind: no credentials, no network, and the turn loop is the library's own.

// The scripted mind answers the brief in one attempt. It honors the Infer contract by ending the
// turn rather than calling a tool, which is all these assertions need
// (packages/agent/src/index.test.ts, the scripted mind).
const briefOf = (trajectory: ReadonlyArray<Event>): string => {
  for (let i = trajectory.length - 1; i >= 0; i--) {
    const event = trajectory[i]!
    if (event.type === "MessageReceived") return String((event as { text?: unknown }).text ?? "")
  }
  return ""
}

const scripted = (request: InferRequest): Action => ({ kind: "complete", output: `ok: ${briefOf(request.trajectory)}` })

const layerScripted: Layer.Layer<Infer> = Layer.succeed(Infer)({
  react: (request: InferRequest) => Effect.succeed(scripted(request))
})

// The database is ":memory:", so each test opens its own store and closes it with the scope.
const config = layerConfig(readConfig({ TARDIGRADE_DB: ":memory:" }))

// The body runs with both services the layer provides: the agents it drives, and the gauge
// /healthz reads over the same driver (http.ts, DriverGauge).
const running = <A, E>(
  body: (agents: Context.Service.Shape<typeof Agents>) => Effect.Effect<A, E, DriverGauge>
): Promise<A> =>
  Effect.gen(function*() {
    const agents = yield* Agents
    return yield* body(agents)
  }).pipe(
    Effect.provide(Layer.provide(layerAgents({ infer: layerScripted }), config)),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

describe("the agents service", () => {
  test("a delivered brief drives to a completed turn", async () => {
    const types = await running((agents) =>
      Effect.gen(function*() {
        const accepted = yield* agents.deliver("alpha", { id: "m1", text: "hello" })
        expect(accepted).toEqual({ agent: "alpha", turn: "m1" })
        yield* agents.settled
        const gauge = yield* DriverGauge
        expect(yield* gauge.dirty).toBe(0)
        expect(yield* gauge.resting).toBe(true)
        return (yield* agents.events("alpha")).map((e) => e.type)
      })
    )
    expect(types).toContain("TurnCompleted")
  })

  test("list names every agent lane with its log", async () => {
    const listed = await running((agents) =>
      Effect.gen(function*() {
        yield* agents.deliver("alpha", { id: "m1", text: "hello" })
        yield* agents.deliver("beta", { id: "m2", text: "hello" })
        yield* agents.settled
        return yield* agents.list()
      })
    )
    expect(listed.map((entry) => entry.id)).toEqual(["alpha", "beta"])
    expect(listed.every((entry) => entry.events.some((e) => e.type === "TurnCompleted"))).toBe(true)
  })

  test("a turn that did not fail refuses to resume", async () => {
    const refused = await running((agents) =>
      Effect.gen(function*() {
        yield* agents.deliver("alpha", { id: "m1", text: "hello" })
        yield* agents.settled
        return yield* Effect.flip(agents.resume("alpha", "m1"))
      })
    )
    expect(refused).toBeInstanceOf(ResumeRefused)
    expect(refused.turn).toBe("m1")
    expect(refused.detail).toContain("cannot resume")
  })

  test("redelivering one message id is absorbed", async () => {
    const counts = await running((agents) =>
      Effect.gen(function*() {
        yield* agents.deliver("alpha", { id: "m1", text: "hello" })
        yield* agents.settled
        const before = (yield* agents.events("alpha")).length
        yield* agents.deliver("alpha", { id: "m1", text: "hello" })
        yield* agents.settled
        return [before, (yield* agents.events("alpha")).length]
      })
    )
    expect(counts[1]).toBe(counts[0]!)
  })
})
