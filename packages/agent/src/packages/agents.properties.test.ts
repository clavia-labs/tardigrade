import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/runtime"
import { threadAddressOf, type ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import type { RoutedEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import { threadCreated, threadCreatedOf, threadKeys, type ChildCreated } from "@clavia/tardigrade-core/thread"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentsPackage } from "./agents"

interface CallPlan {
  readonly callId: string
  readonly failures: number
  readonly failurePoint: "record" | "before" | "after"
  readonly placement: "colocated" | "independent" | undefined
}

const callPlan = fc.record({
  callId: fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
  failures: fc.integer({ min: 0, max: 4 }),
  failurePoint: fc.constantFrom<CallPlan["failurePoint"]>("record", "before", "after"),
  placement: fc.option(fc.constantFrom<"colocated" | "independent">("colocated", "independent"), { nil: undefined })
})

const plans = fc.uniqueArray(callPlan, { selector: (plan) => plan.callId, minLength: 1, maxLength: 7 })

// childProtocol runs the implementation against the transitions in Child.tla. The parent log is
// durable across attempts, with finite failures before creation or on either side of delivery.
const childProtocol = async (calls: ReadonlyArray<CallPlan>): Promise<void> => {
  const parent = threadAddressOf("property", "main", "ag.root")
  const host = createHost({ actorName: parent.actor, actorFor: () => undefined })
  // The parent run every spawn reads its identity from: one open turn, one recorded call per plan.
  const parentLog: Event[] = [
    threadCreated(parent, undefined, 0),
    { type: "MessageReceived", id: "turn-1", text: "delegate", at: 1 },
    ...calls.map((plan): Event => ({
      type: "PackageCalled",
      callId: plan.callId,
      name: "agents.run",
      arguments: {},
      turn: "turn-1",
      at: 2
    }))
  ]
  const actions: Array<{ readonly kind: "append" | "send"; readonly callId: string; readonly target?: ThreadAddress }> = []
  const remaining = new Map(calls.map((plan) => [plan.callId, plan.failures]))
  const plansByCall = new Map(calls.map((plan) => [plan.callId, plan]))
  const append = (events: ReadonlyArray<Event>): Effect.Effect<void> => Effect.sync(() => {
    for (const event of events) {
      if (event.type === "ChildCreated") {
        const callId = String(event.callId)
        const left = remaining.get(callId) ?? 0
        if (left > 0 && plansByCall.get(callId)?.failurePoint === "record") {
          remaining.set(callId, left - 1)
          throw new Error("injected creation record failure")
        }
      }
      const key = threadKeys.keyOf(event)
      if (key !== undefined && parentLog.some((candidate) => threadKeys.keyOf(candidate) === key)) continue
      parentLog.push(event)
      if (event.type === "ChildCreated") {
        actions.push({ kind: "append", callId: String((event as { readonly callId?: unknown }).callId) })
      }
    }
  })
  const router = Layer.succeed(Router, {
    send: (envelope: RoutedEnvelope) => Effect.sync(() => {
      const callId = String((envelope.event as { readonly id?: unknown }).id)
      const target = envelope.link.target as ThreadAddress
      actions.push({ kind: "send", callId, target })
      const left = remaining.get(callId) ?? 0
      const plan = plansByCall.get(callId)!
      if (left > 0) {
        remaining.set(callId, left - 1)
        if (plan.failurePoint === "after") host.commit(envelope as never)
        throw new Error(`injected ${plan.failurePoint} commit failure`)
      }
      host.commit(envelope as never)
    })
  })
  const environment = Layer.mergeAll(
    router,
    Layer.succeed(Self, parent),
    Layer.succeed(EventLog, withWatermark({ append, read: Effect.succeed(parentLog) }))
  )
  const run = agentsPackage().methods.run!

  for (const plan of calls) {
    for (let attempt = 0; attempt <= plan.failures; attempt++) {
      const result = await Effect.runPromise(
        run(
          { text: plan.callId, background: true, ...(plan.placement === undefined ? {} : { placement: plan.placement }) },
          { callId: plan.callId }
        ).pipe(Effect.provide(environment), Effect.exit)
      )
      expect(result._tag).toBe(attempt < plan.failures ? "Failure" : "Success")
      if (result._tag === "Success") expect(result.value).toEqual({ dispatched: true, callId: plan.callId })
    }
  }

  const records = parentLog.filter((event): event is ChildCreated => event.type === "ChildCreated")
  expect(records).toHaveLength(calls.length)
  expect(new Set(records.map((record) => `${record.address.actor}:${record.address.thread}`)).size).toBe(calls.length)

  for (const plan of calls) {
    const record = records.find((candidate) => candidate.callId === plan.callId)!
    const callActions = actions.filter((action) => action.callId === plan.callId)
    expect(callActions[0]?.kind).toBe("append")
    expect(callActions.filter((action) => action.kind === "append")).toHaveLength(1)
    expect(callActions.filter((action) => action.kind === "send")).toHaveLength(
      plan.failurePoint === "record" ? 1 : plan.failures + 1
    )
    for (const sent of callActions.filter((action) => action.kind === "send")) expect(sent.target).toEqual(record.address)

    const childLog = host.read(record.address.thread)
    expect(childLog).toHaveLength(2)
    expect(threadCreatedOf(childLog)).toEqual({
      type: "ThreadCreated",
      address: record.address,
      parent,
      depth: record.depth,
      ...(record.placement === undefined ? {} : { placement: record.placement }),
      at: expect.any(Number)
    })
    expect(childLog.filter((event) => event.type === "MessageReceived")).toHaveLength(1)
  }
}

describe("child creation protocol", () => {
  test("liveness: creation completes after finite failures when dispatch is retried", async () => {
    await fc.assert(fc.asyncProperty(plans, childProtocol), { numRuns: 200 })
  })

  test("safety: parent threads, turns, and depths isolate children while replay retains ownership", async () => {
    await fc.assert(fc.asyncProperty(
      fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.string({ minLength: 1, maxLength: 30 }),
      fc.integer({ min: 2, max: 5 }),
      async (rootId, turnToken, callToken, depth) => {
        const turn = `turn:${turnToken}`
        const callId = `call:${callToken}`
        const host = createHost({ actorName: "property", actorFor: () => undefined })
        const targets = new Set<string>()
        const run = agentsPackage().methods.run!
        const dispatch = async (parent: ThreadAddress, level: number): Promise<ThreadAddress> => {
          const events: Event[] = [...host.read(parent.thread)]
          for (const event of events.filter((event) => event.type === "MessageReceived")) {
            events.push({ type: "TurnCompleted", turn: event.id, output: "accepted", at: 1 })
          }
          let target: ThreadAddress | undefined
          const environment = Layer.mergeAll(
            Layer.succeed(Self, parent),
            Layer.succeed(EventLog, withWatermark({
              read: Effect.succeed(events),
              append: (tail) => Effect.sync(() => {
                for (const event of tail) {
                  const key = threadKeys.keyOf(event)
                  if (key !== undefined && events.some((prior) => threadKeys.keyOf(prior) === key)) continue
                  events.push(event)
                }
              })
            })),
            Layer.succeed(Router, {
              send: (envelope) => Effect.sync(() => {
                target = envelope.link.target as ThreadAddress
                host.commit(envelope as never)
              })
            })
          )
          for (const currentTurn of [turn, `${turn}x`]) {
            events.push(
              { type: "MessageReceived", id: currentTurn, text: "delegate", at: 1 },
              { type: "PackageCalled", callId, name: "agents.run", turn: currentTurn, at: 2 }
            )
            const invoke = () => Effect.runPromise(run({ text: "child", background: true }, { callId })
              .pipe(Effect.provide(environment)))
            expect(await invoke()).toEqual({ dispatched: true, callId })
            const first = target!
            expect(first.thread).toMatch(/^[0-9a-f]{64}$/)
            expect(first.thread).not.toBe(parent.thread)
            expect(targets.has(first.thread)).toBe(false)
            targets.add(first.thread)
            expect(await invoke()).toEqual({ dispatched: true, callId })
            expect(target).toEqual(first)
            const records = events.filter((event) => event.type === "ChildCreated" && event.turn === currentTurn)
            expect(records).toHaveLength(1)
            expect(records[0]).toMatchObject({ address: first, callId, depth: level + 1 })
            const childLog = host.read(first.thread)
            expect(threadCreatedOf(childLog)).toMatchObject({ address: first, parent, depth: level + 1 })
            expect(childLog.filter((event) => event.type === "MessageReceived")).toHaveLength(1)
            events.push({ type: "TurnCompleted", turn: currentTurn, output: "done", at: 3 })
          }
          return target!
        }
        for (const thread of [rootId, `${rootId}x`]) {
          let parent = threadAddressOf("property", "main", thread)
          host.seed(thread, [threadCreated(parent, undefined, 0)])
          for (let level = 0; level < depth; level++) parent = await dispatch(parent, level)
        }
        expect(targets.size).toBe(4 * depth)
      }
    ), { numRuns: 100 })
  })
})
