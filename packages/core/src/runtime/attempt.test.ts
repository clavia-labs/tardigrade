import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import type { Event } from "@clavia/tardigrade-core/event"
import { composeKeys, EventLog, keysFor, withWatermark } from "@clavia/tardigrade-core/log"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { completeTransitionProjection, type Transition } from "@clavia/tardigrade-core/transition"
import {
  attempted,
  attemptKeys,
  attemptsProjection,
  type AttemptRecord,
  type AttemptsExhausted
} from "./attempt"
import { actorFromProjections, createActorReconciler } from "./reconciler"

const emptyRecord: AttemptRecord = { attempts: 0, failures: 0, exhausted: false }

const freshSignal = (): AbortSignal => new AbortController().signal

const memoryLog = (events: Array<Event>) => Layer.succeed(
  EventLog,
  withWatermark({
    append: (batch) => Effect.sync(() => { events.push(...batch) }),
    read: Effect.sync(() => [...events])
  })
)

const runAttempt = (
  transition: Transition<never, never>,
  events: Array<Event>
): Promise<ReadonlyArray<Event>> => {
  if (transition.kind !== "effect") throw new Error("expected an effect")
  return Effect.runPromise(transition.act(transition.input, freshSignal()).pipe(
    Effect.provide(memoryLog(events))
  ))
}

describe("durable attempts", () => {
  test("a typed failure records evidence without committing the operation", async () => {
    const events: Array<Event> = []
    const transition = attempted(emptyRecord, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 2, backoffMs: [0] },
      act: () => Effect.fail("offline")
    })[0]!

    const returned = await runAttempt(transition, events)
    events.push(...returned)
    const record = replayProjection(attemptsProjection, events)("op:one")

    expect(events).toEqual([
      { type: "AttemptStarted", operation: "op:one", attempt: 0, at: expect.any(Number) },
      {
        type: "AttemptFailed",
        operation: "op:one",
        attempt: 0,
        error: "offline",
        retryAt: expect.any(Number),
        at: expect.any(Number)
      }
    ])
    expect(attemptKeys.keyOf(events[1]!)).toBe("attf:op:one/0")
    expect(attempted(record, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 2, backoffMs: [0] },
      act: () => Effect.succeed([])
    })[0]?.key).toBe("att:op:one/1")
  })

  test("the ceiling records a policy-carrying terminal", () => {
    const transition = attempted({
      attempts: 2,
      failures: 1,
      lastError: "offline",
      exhausted: false
    }, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 2, backoffMs: [10], deadlineMs: 100 },
      act: () => Effect.succeed([])
    })[0]!
    expect(transition.kind).toBe("intent")
    if (transition.kind !== "intent") return
    const exhausted = transition.events(transition.input, 200)[0] as AttemptsExhausted
    expect(exhausted).toEqual({
      type: "AttemptsExhausted",
      operation: "op:one",
      attempts: 2,
      cause: "attempts_exhausted",
      policy: { giveUpAfter: 2, backoffMs: [10], deadlineMs: 100 },
      error: "offline",
      at: 200
    })
    expect(attemptKeys.keyOf(exhausted)).toBe("op:one")
  })

  test("a defect leaves a mark that counts toward the ceiling", async () => {
    const events: Array<Event> = []
    const transition = attempted(emptyRecord, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 1, backoffMs: [0] },
      act: () => Effect.die(new Error("process died"))
    })[0]!

    await runAttempt(transition, events).catch(() => undefined)
    const record = replayProjection(attemptsProjection, events)("op:one")
    expect(record.attempts).toBe(1)
    expect(attempted(record, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 1, backoffMs: [0] },
      act: () => Effect.succeed([])
    })[0]?.kind).toBe("intent")
  })

  test("a resumed wait sleeps only until its recorded retry time", async () => {
    const events: Array<Event> = []
    const transition = attempted({
      attempts: 1,
      failures: 1,
      retryAt: 100,
      exhausted: false
    }, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 2, backoffMs: [100] },
      act: () => Effect.succeed([{ type: "OperationCompleted", operation: "one" }])
    })[0]!
    if (transition.kind !== "effect") throw new Error("expected an effect")

    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(40)
      const fiber = yield* Effect.forkChild(transition.act(transition.input, freshSignal()))
      yield* Effect.yieldNow
      yield* TestClock.adjust(59)
      expect(events).toEqual([])
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Layer.merge(memoryLog(events), TestClock.layer()))))

    expect(events).toEqual([{
      type: "AttemptStarted",
      operation: "op:one",
      attempt: 1,
      at: 100
    }])
  })

  test("a deadline commits before a later retry time", async () => {
    const events: Array<Event> = []
    const transition = attempted({
      attempts: 1,
      failures: 1,
      lastError: "offline",
      retryAt: 200,
      deadlineAt: 100,
      exhausted: false
    }, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 3, backoffMs: [100], deadlineMs: 100 },
      act: () => Effect.succeed([])
    })[0]!
    if (transition.kind !== "effect") throw new Error("expected an effect")

    const returned = await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(90)
      const fiber = yield* Effect.forkChild(transition.act(transition.input, freshSignal()))
      yield* Effect.yieldNow
      yield* TestClock.adjust(10)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Layer.merge(memoryLog(events), TestClock.layer()))))

    expect(events).toEqual([])
    expect(returned).toEqual([{
      type: "AttemptsExhausted",
      operation: "op:one",
      attempts: 1,
      cause: "deadline",
      policy: { giveUpAfter: 3, backoffMs: [100], deadlineMs: 100 },
      error: "offline",
      at: 100
    }])
  })

  test("a deadline stops an active attempt", async () => {
    const events: Array<Event> = []
    let aborted = false
    const transition = attempted(emptyRecord, {
      operation: "op:one",
      input: undefined,
      policy: { giveUpAfter: 3, backoffMs: [100], deadlineMs: 50 },
      act: (_input, signal) => Effect.callback<ReadonlyArray<Event>>(() => {
        signal.addEventListener("abort", () => { aborted = true }, { once: true })
      })
    })[0]!
    if (transition.kind !== "effect") throw new Error("expected an effect")

    const returned = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(transition.act(transition.input, freshSignal()))
      yield* Effect.yieldNow
      yield* TestClock.adjust(50)
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(Layer.merge(memoryLog(events), TestClock.layer()))))

    expect(events).toEqual([{
      type: "AttemptStarted",
      operation: "op:one",
      attempt: 0,
      deadlineAt: 50,
      at: 0
    }])
    expect(aborted).toBe(true)
    expect(returned[0]).toMatchObject({
      type: "AttemptsExhausted",
      operation: "op:one",
      attempts: 1,
      cause: "deadline",
      at: 50
    })
  })

  test("a fresh reconciler resumes a died attempt and commits once", async () => {
    const events: Array<Event> = []
    let calls = 0
    const derive = (log: ReadonlyArray<Event>) => {
      if (log.some((event) => event.type === "OperationCompleted")) return []
      const record = replayProjection(attemptsProjection, log)("op:one")
      return attempted(record, {
        operation: "op:one",
        input: undefined,
        policy: { giveUpAfter: 3, backoffMs: [0] },
        concurrent: true,
        act: () => Effect.suspend(() => {
          calls += 1
          return calls === 1
            ? Effect.die(new Error("process died"))
            : Effect.succeed([{ type: "OperationCompleted", operation: "one" }])
        })
      })
    }
    const actor = actorFromProjections({
      transitions: [completeTransitionProjection(derive)],
      keyOf: composeKeys(
        attemptKeys,
        keysFor("op:", {
          OperationCompleted: (event) => String((event as { operation?: unknown }).operation)
        })
      )
    })

    await expect(Effect.runPromise(
      createActorReconciler(actor).settle.pipe(Effect.provide(memoryLog(events)))
    )).rejects.toThrow("process died")
    const resumed = createActorReconciler(actor)
    await Effect.runPromise(resumed.settle.pipe(Effect.provide(memoryLog(events))))
    await Effect.runPromise(resumed.settle.pipe(Effect.provide(memoryLog(events))))

    expect(calls).toBe(2)
    expect(events.filter((event) => event.type === "AttemptStarted")).toHaveLength(2)
    expect(events.filter((event) => event.type === "OperationCompleted")).toHaveLength(1)
  })
})
