import { describe, expect, test } from "bun:test"
import { Clock, Context, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { Event } from "@flamecast/core"
import { InMemoryRuntime } from "@flamecast/runtime-in-memory"
import { alarmFired } from "../alphabet"
import { inferWith, RequestOptionsProjection, ZERO_USAGE, type Action, type ModelRequest } from "../infer"
import { keyOf } from "../keys"
import { createAgent } from "../module"
import { serve } from "../serve"
import { inference } from "./inference"
import { requestOptions } from "./request-options"

const usage = { promptTokens: 10, completionTokens: 2, costUsd: 0.0001 }

const scripted = (actions: ReadonlyArray<Action>) => {
  const seen: Array<ModelRequest> = []
  const keys: Array<string> = []
  return {
    seen,
    keys,
    layer: inferWith(async (request, key) => {
      seen.push(request)
      keys.push(key)
      const next = actions[seen.length - 1]
      if (next === undefined) throw new Error(`the stub model ran out of actions after ${seen.length}`)
      return next
    }, { contextWindow: 200_000 })
  }
}

describe("a deferred model call", () => {
  const agent = createAgent({
    modules: [inference({ contextWindow: 200_000, deferAtMost: 2 })]
  })

  test("journals the wait and rests, then retries with the same key", async () => {
    const model = scripted([
      { kind: "defer", error: "the gateway is queued", retryAfterMs: 60_000, usage },
      { kind: "complete", output: "done", usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)

    const parked = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.turn({ id: "m-1", text: "hello" })
          return { result, log: yield* agent.log }
        }),
        layer
      )
    )

    expect(parked.result).toMatchObject({
      kind: "deferred",
      callId: "m-1/infer/0",
      attempt: 1,
      reason: "the gateway is queued"
    })
    expect(parked.log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelSettled",
      "ModelDeferred"
    ])
    expect(model.keys).toEqual(["m-1/infer/0"])
    const deferred = parked.log.find((event) => event.type === "ModelDeferred")
    expect(Number(deferred?.notBefore)).toBe(Number(deferred?.at) + 60_000)

    const resumed = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.replay([
            alarmFired({ turn: "m-1", callId: "m-1/infer/0", attempt: 1, at: yield* Clock.currentTimeMillis })
          ])
          return { result, log: yield* agent.log }
        }),
        layer
      )
    )

    expect(resumed.result).toMatchObject({ kind: "completed", output: "done" })
    expect(model.keys).toEqual(["m-1/infer/0", "m-1/infer/0"])
    expect(resumed.log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelSettled",
      "ModelDeferred",
      "AlarmFired",
      "ModelCalled",
      "ModelReturned",
      "TurnCompleted",
      "ReplyDelivered"
    ])
  })

  test("gives up once the deferrals are spent", async () => {
    const model = scripted([
      { kind: "defer", error: "queued", retryAfterMs: 60_000, usage },
      { kind: "defer", error: "still queued", retryAfterMs: 60_000, usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
    const wake = (at: number, attempt: number) =>
      alarmFired({ turn: "m-1", callId: "m-1/infer/0", attempt, at })

    const first = await Effect.runPromise(Effect.provide(agent.turn({ id: "m-1", text: "hello" }), layer))
    expect(first.kind).toBe("deferred")

    const second = await Effect.runPromise(Effect.provide(agent.replay([wake(2, 1)]), layer))
    expect(second).toMatchObject({ kind: "deferred", attempt: 2 })

    const third = await Effect.runPromise(Effect.provide(agent.replay([wake(3, 2)]), layer))
    expect(third).toMatchObject({ kind: "failed", error: "the model was deferred 2 times" })
    expect(model.keys).toHaveLength(2)
  })

  test("a died attempt becomes a deferral instead of retrying immediately", async () => {
    const model = scripted([{ kind: "complete", output: "recovered", usage }])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
    const seeded: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m-1", text: "hello", at: 1 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", at: 2 }
    ]

    const parked = await Effect.runPromise(Effect.provide(agent.replay(seeded), layer))
    expect(parked).toMatchObject({
      kind: "deferred",
      callId: "m-1/infer/0",
      reason: "the model attempt died"
    })
    expect(model.keys).toEqual([])
    const log = await Effect.runPromise(Effect.provide(agent.log, layer))
    expect(log.map((event) => event.type)).toEqual([
      "MessageReceived",
      "ModelCalled",
      "ModelSettled",
      "ModelDeferred"
    ])

    const resumed = await Effect.runPromise(
      Effect.provide(
        agent.replay([alarmFired({ turn: "m-1", callId: "m-1/infer/0", attempt: 1, at: 3 })]),
        layer
      )
    )
    expect(resumed).toMatchObject({ kind: "completed", output: "recovered" })
    expect(model.keys).toEqual(["m-1/infer/0"])
  })

  // The defect this pins: giving up settled the last mark again, even though its deferral had
  // already settled it. A turn whose every attempt was refused before it ran reported the whole
  // reservation as spend, which is the figure the reservation exists to keep honest.
  test("settles each attempt once, so a turn that never ran reports no spend", async () => {
    const model = scripted([
      { kind: "defer", error: "queued", retryAfterMs: 60_000 },
      { kind: "defer", error: "still queued", retryAfterMs: 60_000 }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
    const wake = (at: number, attempt: number) =>
      alarmFired({ turn: "m-1", callId: "m-1/infer/0", attempt, at })

    await Effect.runPromise(Effect.provide(agent.turn({ id: "m-1", text: "hello" }), layer))
    await Effect.runPromise(Effect.provide(agent.replay([wake(2, 1)]), layer))
    const spent = await Effect.runPromise(Effect.provide(agent.replay([wake(3, 2)]), layer))
    const log = await Effect.runPromise(Effect.provide(agent.log, layer))

    expect(spent.kind).toBe("failed")
    // Two attempts, two settles. A third would be the same attempt counted twice.
    expect(log.filter((event) => event.type === "ModelSettled")).toHaveLength(2)
    expect(spent.usage.unsettled).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 })
  })

  test("a restart whose due time has passed wakes from the log", async () => {
    const model = scripted([{ kind: "complete", output: "late", usage }])
    // What a wait actually looks like on the log: the attempt is settled, then the wait is
    // journaled with the time it comes due.
    const seeded: ReadonlyArray<Event> = [
      { type: "MessageReceived", id: "m-1", text: "hello", at: 1 },
      { type: "ModelCalled", turn: "m-1", callId: "m-1/infer/0", reserved: ZERO_USAGE, at: 2 },
      {
        type: "ModelSettled",
        turn: "m-1",
        callId: "m-1/infer/0",
        usage: ZERO_USAGE,
        reason: "queued",
        at: 3
      },
      {
        type: "ModelDeferred",
        turn: "m-1",
        callId: "m-1/infer/0",
        attempt: 1,
        notBefore: 0,
        reason: "queued",
        at: 4
      }
    ]
    const result = await Effect.runPromise(
      Effect.provide(
        agent.replay(seeded),
        Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
      )
    )
    expect(result).toMatchObject({ kind: "completed", output: "late" })
    expect(model.keys).toEqual(["m-1/infer/0"])
  })
})

describe("an in-memory alarm", () => {
  test("wakes a served session at the due time", async () => {
    const agent = createAgent({
      modules: [inference({ contextWindow: 200_000 })]
    })
    const model = scripted([
      { kind: "defer", error: "queued", retryAfterMs: 60_000, usage },
      { kind: "complete", output: "awake", usage }
    ])
    const runtime = InMemoryRuntime({
      keyOf,
      session: "user-42",
      sessions: { "user-42": serve(agent) }
    })

    const log = await Effect.runPromise(
      Effect.gen(function* () {
        const parked = yield* agent.turn({ id: "m-1", text: "hello" })
        expect(parked.kind).toBe("deferred")
        yield* TestClock.adjust("1 minute")
        yield* Effect.yieldNow
        return yield* agent.log
      }).pipe(Effect.provide(Layer.mergeAll(runtime, model.layer, TestClock.layer())))
    )

    expect(log.map((event) => event.type)).toContain("TurnCompleted")
    expect(model.keys).toEqual(["m-1/infer/0", "m-1/infer/0"])
  })
})

describe("reserve then settle", () => {
  test("ModelCalled carries a reservation, and a live result settles it", async () => {
    const agent = createAgent({ modules: [inference({ contextWindow: 200_000 })] })
    const model = scripted([{ kind: "complete", output: "done", usage }])
    const { log, result } = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const result = yield* agent.turn({ id: "m-1", text: "hello" })
          return { result, log: yield* agent.log }
        }),
        Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
      )
    )
    const called = log.find((event) => event.type === "ModelCalled")
    expect(Number((called?.reserved as { promptTokens?: number } | undefined)?.promptTokens)).toBeGreaterThan(
      0
    )
    expect(result.usage.settled).toEqual(usage)
    expect(result.usage.unsettled).toEqual({ promptTokens: 0, completionTokens: 0, costUsd: 0 })
  })

  test("a price table fills a cost the provider omitted, and a reported zero stays zero", async () => {
    const pricing = { promptUsdPerToken: 0.001, completionUsdPerToken: 0.002 }
    const agent = createAgent({ modules: [inference({ contextWindow: 200_000 })] })
    const omitted = inferWith(
      async () => ({
        kind: "complete",
        output: "ok",
        usage: { promptTokens: 10, completionTokens: 4 }
      }),
      { contextWindow: 200_000, pricing }
    )
    const filled = await Effect.runPromise(
      Effect.provide(
        agent.turn({ id: "m-1", text: "hello" }),
        Layer.merge(InMemoryRuntime({ keyOf, session: "user-1" }), omitted)
      )
    )
    expect(filled.usage.settled.costUsd).toBeCloseTo(10 * 0.001 + 4 * 0.002, 10)

    const reported = inferWith(
      async () => ({
        kind: "complete",
        output: "ok",
        usage: { promptTokens: 10, completionTokens: 4, costUsd: 0 }
      }),
      { contextWindow: 200_000, pricing }
    )
    const zero = await Effect.runPromise(
      Effect.provide(
        agent.turn({ id: "m-2", text: "hello" }),
        Layer.merge(InMemoryRuntime({ keyOf, session: "user-2" }), reported)
      )
    )
    expect(zero.usage.settled.costUsd).toBe(0)
  })
})

describe("per-request options as a projection", () => {
  // The policy is a fold, so what it chose is a function of the log and a replay chooses the same.
  // The framework ships none: which setting is worth its cost, and what a provider calls it, belong
  // to the deployment. This one escalates thinking after the queue has made the turn wait.
  const harder = requestOptions({
    id: "harder-after-a-wait",
    of: (log) => ({
      reasoning:
        log.filter((event) => event.type === "ModelDeferred").length >= 2 ? "high" : "low"
    })
  })

  test("reads what has already happened, and a retry sends the new choice", async () => {
    const agent = createAgent({
      modules: [inference({ contextWindow: 200_000, deferAtMost: 4 }), harder]
    })
    const model = scripted([
      { kind: "defer", error: "queued", retryAfterMs: 1_000, usage },
      { kind: "defer", error: "queued", retryAfterMs: 1_000, usage },
      { kind: "complete", output: "done", usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
    const wake = (at: number, attempt: number) =>
      alarmFired({ turn: "m-1", callId: model.keys[model.keys.length - 1] ?? "", attempt, at })

    await Effect.runPromise(Effect.provide(agent.turn({ id: "m-1", text: "hello" }), layer))
    await Effect.runPromise(Effect.provide(agent.replay([wake(2, 1)]), layer))
    await Effect.runPromise(Effect.provide(agent.replay([wake(3, 2)]), layer))

    expect(model.seen.map((request) => request.options?.reasoning)).toEqual([
      "low",
      "low",
      "high"
    ])
  })

  // A changed setting is a changed request, so it can not reuse the key that told the gateway the
  // last one was the same call. The first two attempts share a key; the third, sent with different
  // settings, mints its own.
  test("mints a new call when the settings change, and reuses the key when they do not", async () => {
    const agent = createAgent({
      modules: [inference({ contextWindow: 200_000, deferAtMost: 4 }), harder]
    })
    const model = scripted([
      { kind: "defer", error: "queued", retryAfterMs: 1_000, usage },
      { kind: "defer", error: "queued", retryAfterMs: 1_000, usage },
      { kind: "complete", output: "done", usage }
    ])
    const layer = Layer.merge(InMemoryRuntime({ keyOf, session: "user-42" }), model.layer)
    const wake = (at: number, attempt: number) =>
      alarmFired({ turn: "m-1", callId: model.keys[model.keys.length - 1] ?? "", attempt, at })

    await Effect.runPromise(Effect.provide(agent.turn({ id: "m-1", text: "hello" }), layer))
    await Effect.runPromise(Effect.provide(agent.replay([wake(2, 1)]), layer))
    await Effect.runPromise(Effect.provide(agent.replay([wake(3, 2)]), layer))

    expect(model.keys[0]).toBe("m-1/infer/0")
    expect(model.keys[1]).toBe("m-1/infer/0")
    expect(model.keys[2]).not.toBe("m-1/infer/0")
  })

  test("agent.request exposes the projected options", () => {
    const agent = createAgent({
      modules: [inference({ contextWindow: 200_000 }), harder]
    })

    expect(agent.request([]).options).toEqual({ reasoning: "low" })
    expect(Context.get(agent.services, RequestOptionsProjection)([])).toEqual({ reasoning: "low" })
  })
})
