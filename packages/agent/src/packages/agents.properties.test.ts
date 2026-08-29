import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { EventLog, withWatermark } from "@clavia/tardigrade-core/log"
import { Router } from "@clavia/tardigrade-core/communication/router"
import { Self } from "@clavia/tardigrade-core/reconciliation"
import { threadAddressOf, type ThreadAddress } from "@clavia/tardigrade-core/communication/endpoint"
import type { RoutedEnvelope } from "@clavia/tardigrade-core/communication/envelope"
import { threadCreated, threadCreatedOf, threadKeys, type ChildCreated } from "@clavia/tardigrade-core/thread"
import { createHost } from "@clavia/tardigrade-host/host"
import { agentsPackage } from "./agents"

interface CallPlan {
  readonly callId: string
  readonly failures: number
  readonly failurePoint: "before" | "after"
  readonly placement: "colocated" | "independent" | undefined
}

const callPlan = fc.record({
  callId: fc.stringMatching(/^[a-z][a-z0-9_]{0,12}$/),
  failures: fc.integer({ min: 0, max: 4 }),
  failurePoint: fc.constantFrom<CallPlan["failurePoint"]>("before", "after"),
  placement: fc.option(fc.constantFrom<"colocated" | "independent">("colocated", "independent"), { nil: undefined })
})

const plans = fc.uniqueArray(callPlan, { selector: (plan) => plan.callId, minLength: 1, maxLength: 7 })

// childProtocol runs the implementation against the transitions in Child.tla. The parent log is
// durable across attempts, while the router may fail on either side of the child commit.
const childProtocol = async (calls: ReadonlyArray<CallPlan>): Promise<void> => {
  const parent = threadAddressOf("property", "ag.root")
  const host = createHost({ actorName: parent.actor, actorFor: () => undefined })
  const parentLog: Event[] = [threadCreated(parent, undefined, 0)]
  const actions: Array<{ readonly kind: "append" | "send"; readonly callId: string; readonly target?: ThreadAddress }> = []
  const remaining = new Map(calls.map((plan) => [plan.callId, plan.failures]))
  const plansByCall = new Map(calls.map((plan) => [plan.callId, plan]))
  const append = (events: ReadonlyArray<Event>): Effect.Effect<void> => Effect.sync(() => {
    for (const event of events) {
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
      await Effect.runPromise(
        run(
          { text: plan.callId, background: true, ...(plan.placement === undefined ? {} : { placement: plan.placement }) },
          { callId: plan.callId }
        ).pipe(Effect.provide(environment), Effect.exit)
      )
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
    expect(callActions.filter((action) => action.kind === "send")).toHaveLength(plan.failures + 1)
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
  test("matches Child.tla across retries and crash windows", async () => {
    await fc.assert(fc.asyncProperty(plans, childProtocol), { numRuns: 200 })
  })
})
