import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { legacyActorMethod } from "./legacy"
import { METHOD_SEALED_EVENT_TYPE, methodIsSealed, methodSealOf, methodSealed } from "./seal"
import { actorInvocationContextFrom, methodIngressKeyOf, methodSealKey } from "./call"
import {
  cancellationDispositionOf,
  hasUnsettledInvocationChildren,
  unsettledInvocationParentsOf
} from "./cancellation"
import type { ActorInvocation } from "./call"

describe("method seals", () => {
  test("the seal constructor refuses an empty method and an unsafe time", () => {
    expect(() => methodSealed({ method: "", at: 1 })).toThrow("sealed method must not be empty")
    expect(() => methodSealed({ method: "message", at: -1 })).toThrow("sealed method time must be a non-negative safe integer")
    expect(() => methodSealed({ method: "message", at: 1.5 })).toThrow("sealed method time must be a non-negative safe integer")
    expect(methodSealed({ method: "message", reason: "deleted", at: 1 })).toEqual({
      type: "MethodSealed",
      method: "message",
      reason: "deleted",
      at: 1
    })
    expect(methodSealed({ method: "message", at: 1 })).toEqual({
      type: "MethodSealed",
      method: "message",
      at: 1
    })
  })

  test("the decoder accepts only well-formed seals", () => {
    const seal = methodSealed({ method: "message", reason: "deleted", at: 1 })
    expect(methodSealOf(seal)).toEqual(seal)
    expect(methodSealOf({ type: "MessageReceived", id: "m1", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: -1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: 1.5 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: 1, reason: 3 } as Event)).toBeUndefined()
  })

  test("a sealed method stays sealed", () => {
    const log = [
      { type: "MessageReceived", id: "m1", at: 1 } as Event,
      methodSealed({ method: "message", at: 2 })
    ]
    expect(methodIsSealed(log, "message")).toBe(true)
    expect(methodIsSealed(log, "requestBudget")).toBe(false)
    expect(methodIsSealed([], "message")).toBe(false)
    expect(log[1]!.type).toBe(METHOD_SEALED_EVENT_TYPE)
  })

  test("a seal owns its ingress key, so the store keys and refuses on it", () => {
    const seal = methodSealed({ method: "message", at: 1 })
    expect(methodIngressKeyOf(seal)).toBe(methodSealKey("message"))
    expect(methodSealKey("message")).toBe(`mseal:${JSON.stringify("message")}`)
    expect(methodIngressKeyOf({ type: "MessageReceived", id: "m1", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf(seal)!.method).toBe("message")
  })
})

// One cancellable method, in the shape the drain endpoint answers for: every call names its
// durable context, so direct enumeration sees it (call.ts, actorInvocationContextFrom).
const work = legacyActorMethod({
  input: Schema.String,
  output: Schema.String,
  event: ({ invocation, at }) => ({ type: "WorkStarted", id: invocation.id, at }),
  state: () => ({ status: "pending" }),
  cancellation: {
    state: (events, { id }) => {
      if (!events.some((event) => event.type === "WorkStarted" && String((event as { readonly id?: unknown }).id) === id)) return undefined
      if (events.some((event) => event.type === "WorkCancelled" && String((event as { readonly id?: unknown }).id) === id)) return "cancelled"
      if (events.some((event) => event.type === "WorkCompleted" && String((event as { readonly id?: unknown }).id) === id)) return "terminal"
      return "running"
    },
    event: (cancellation, at) => ({ type: "WorkCancelled", id: cancellation.invocation.id, at })
  }
})

const started = (id: string, at: number): Event =>
  ({
    type: "WorkStarted",
    id,
    at,
    call: { invocation: { method: "work", id, epoch: 0 }, deadlineAt: at + 1_000 }
  }) as Event

describe("seal drains", () => {
  test("a seal enumerates direct and linked invocations and reads each disposition", () => {
    const running: ActorInvocation = { method: "work", id: "w1", epoch: 0 }
    const completed: ActorInvocation = { method: "work", id: "w2", epoch: 0 }
    const requested: ActorInvocation = { method: "work", id: "w3", epoch: 0 }
    const parent: ActorInvocation = { method: "work", id: "p1", epoch: 0 }
    const child: ActorInvocation = { method: "work", id: "c1", epoch: 0 }
    const log = [
      started("w1", 1),
      started("w2", 2),
      { type: "WorkCompleted", id: "w2", at: 3 } as Event,
      started("w3", 4),
      { type: "CancellationRequested", request: "x3", invocation: requested, cause: "requested", at: 5 } as Event,
      started("p1", 6),
      { type: "WorkCompleted", id: "p1", at: 7 } as Event,
      { type: "InvocationLinked", parent, child: { invocation: child }, target: "ag.child", at: 8 } as Event,
      methodSealed({ method: "work", reason: "deleted", at: 9 })
    ]

    // The sealed method's own calls, enumerated from the durable contexts the log carries.
    const directIds = [...new Set(log.flatMap((event) => {
      const context = actorInvocationContextFrom(event)
      return context?.invocation.method === "work" ? [context.invocation.id] : []
    }))]
    expect(directIds).toEqual(["w1", "w2", "w3", "p1"])
    expect(methodIsSealed(log, "work")).toBe(true)

    // The linked family stays open past its parent's own terminal, so the drain still owes it a
    // cancellation request.
    expect(unsettledInvocationParentsOf(log)).toEqual([parent])
    expect(hasUnsettledInvocationChildren(log, parent)).toBe(true)
    const candidates: ReadonlyArray<ActorInvocation> = [
      ...directIds.map((id) => ({ method: "work", id, epoch: work.currentEpoch(log, id) })),
      ...unsettledInvocationParentsOf(log)
    ]
    expect(candidates).toEqual([running, completed, requested, parent, parent])

    // The disposition table the drain walks: a running call is requestable, a settled call is
    // skipped, an already requested call stays pending, and a settled parent with an unsettled
    // child is cancellable again.
    expect(cancellationDispositionOf(log, work, running)).toBe("requestable")
    expect(cancellationDispositionOf(log, work, completed)).toBe("settled")
    expect(cancellationDispositionOf(log, work, requested)).toBe("requested")
    expect(cancellationDispositionOf(log, work, parent)).toBe("settled")
    expect(cancellationDispositionOf(log, work, parent) === "settled" && hasUnsettledInvocationChildren(log, parent)).toBe(true)

    // Once the child call settles on its target thread, the family closes and the drain owes nothing.
    const settled = [...log, { type: "ResponseReceived", method: child.method, call: child.id, from: "ag.child", at: 10 } as Event]
    expect(unsettledInvocationParentsOf(settled)).toEqual([])
    expect(hasUnsettledInvocationChildren(settled, parent)).toBe(false)
    expect(cancellationDispositionOf(settled, work, parent) === "settled" && hasUnsettledInvocationChildren(settled, parent)).toBe(false)
  })
})
