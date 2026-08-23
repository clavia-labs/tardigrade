import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import type { Delivery } from "@clavia/tardigrade-core/communication/delivery"
import { Ingress } from "@clavia/tardigrade-host/ingress"
import { RESERVED_ACTOR } from "@clavia/tardigrade-client/contract"
import { Infer, type InferRequest } from "tardie"
import type { Action } from "tardie/events"

import { layerConfig, readConfig } from "./config"
import { Threads, layerThreads } from "./host"
import { DriverGauge } from "./http"

// Every case here opens a real store on disk and drives a real host, so it competes with every
// other task in a parallel gate run. Bun's default per-test budget is tuned for a pure function and
// times out under that load; this is the budget a boot actually needs. It stays tight on purpose: a
// case that wants longer than this is hanging rather than busy.
const BOOT_MS = 20_000

setDefaultTimeout(BOOT_MS)

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
const config = layerConfig(readConfig({
  TARDIGRADE_DB: ":memory:",
  TARDIGRADE_ACTORS: `/tmp/tardigrade-host-test-${process.pid}`
}))

// The body runs with both services the layer provides: the threads it drives, and the gauge
// /healthz reads over the same driver (http.ts, DriverGauge).
const running = <A, E>(
  body: (threads: Context.Service.Shape<typeof Threads>) => Effect.Effect<A, E, DriverGauge | Ingress>
): Promise<A> =>
  Effect.gen(function*() {
    const threads = yield* Threads
    return yield* body(threads)
  }).pipe(
    Effect.provide(Layer.provide(layerThreads({
      infer: layerScripted,
      providers: [{ name: "test", send: () => Effect.void }]
    }), config)),
    Effect.scoped,
    Effect.runPromise
  ) as Promise<A>

// One brief, as the event it is. The platform requires only `type`; `id` and `text` are the
// assembly's fields, and `id` is the key its own `keyOf` dedups on (packages/core/src/message.ts).
const brief = (id: string, text = "hello") => ({ type: "MessageReceived", id, text })

describe("the threads service", () => {
  test("ingress commits a deduplicated batch before any actor is driven", async () => {
    const result = await running((threads) =>
      Effect.gen(function*() {
        const ingress = yield* Ingress
        const deliveries: ReadonlyArray<Delivery> = [
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "alpha" }
            },
            event: { type: "MessageReceived", id: "m1", text: "first", at: 42 }
          },
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "beta" }
            },
            event: { type: "MessageReceived", id: "m2", text: "second", at: 43 }
          },
          {
            link: {
              source: { provider: "test" },
              target: { actor: RESERVED_ACTOR, thread: "alpha" }
            },
            event: { type: "MessageReceived", id: "m1", text: "first", at: 42 }
          }
        ]
        yield* ingress.commit(deliveries)
        const gauge = yield* DriverGauge
        const committed = {
          alpha: yield* threads.events("alpha"),
          beta: yield* threads.events("beta"),
          dirty: yield* gauge.dirty,
          resting: yield* gauge.resting
        }
        yield* ingress.schedule(deliveries)
        yield* threads.settled
        return {
          committed,
          settled: {
            alpha: yield* threads.events("alpha"),
            beta: yield* threads.events("beta")
          }
        }
      })
    )

    expect(result.committed.alpha.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(result.committed.beta.map((event) => event.type)).toEqual(["ThreadCreated", "MessageReceived"])
    expect(result.committed.dirty).toBe(0)
    expect(result.committed.resting).toBe(false)
    expect(result.settled.alpha.some((event) => event.type === "TurnCompleted")).toBe(true)
    expect(result.settled.beta.some((event) => event.type === "TurnCompleted")).toBe(true)
  })

  test("an appended brief drives to a completed turn", async () => {
    const types = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        const gauge = yield* DriverGauge
        expect(yield* gauge.dirty).toBe(0)
        expect(yield* gauge.resting).toBe(true)
        return (yield* threads.events("alpha")).map((e) => e.type)
      })
    )
    expect(types).toContain("TurnCompleted")
  })

  test("list names every thread lane with its log", async () => {
    const listed = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.append("beta", brief("m2"))
        yield* threads.settled
        return yield* threads.list
      })
    )
    expect(listed.map((entry) => entry.id)).toEqual(["alpha", "beta"])
    expect(listed.every((entry) => entry.events.some((e) => e.type === "TurnCompleted"))).toBe(true)
  })

  // The service appends whatever fact it is handed and reads none of its fields: what an event
  // means is the actor's knowledge (actor.ts, agentProjections). An append that carries its own
  // `at` keeps it, so a replayed fact keeps the time it happened.
  test("an appended event keeps the time it states", async () => {
    const stamps = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", { type: "MessageReceived", id: "m1", text: "hello", at: 4242 })
        yield* threads.settled
        const log = yield* threads.events("alpha")
        return log.filter((event) => event.type === "MessageReceived").map((event) => event["at"])
      })
    )
    expect(stamps).toEqual([4242])
  })

  test("redelivering one message id is absorbed", async () => {
    const counts = await running((threads) =>
      Effect.gen(function*() {
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        const before = (yield* threads.events("alpha")).length
        yield* threads.append("alpha", brief("m1"))
        yield* threads.settled
        return [before, (yield* threads.events("alpha")).length]
      })
    )
    expect(counts[1]).toBe(counts[0]!)
  })
})
