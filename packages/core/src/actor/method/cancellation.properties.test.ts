import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { Event } from "../../log/event"
import { actorFromReactors, effect, enabled, intent } from "../../reconciliation"
import { effectInterruptionRegistry } from "../../reconciliation"
import type { Component } from "../component"
import type { ActorInvocation } from "./call"
import { actorMethod } from "./definition"
import {
  cancellationKeys,
  cancellationTransitionsOf,
  cancelsInvocation
} from "./cancellation"

const parent = { method: "message", id: "m1", epoch: 0 } as const
const nextEpoch = { method: "message", id: "m1", epoch: 1 } as const
const child = { method: "inspect", id: "m1", epoch: 0 } as const
const invocations = [parent, nextEpoch, child] as const

const sameInvocation = (left: ActorInvocation, right: ActorInvocation): boolean =>
  left.method === right.method && left.id === right.id && left.epoch === right.epoch

const started = (invocation: ActorInvocation, at: number): Event => ({
  type: "InvocationStarted",
  invocation,
  at
}) as Event

const cancelled = (invocation: ActorInvocation, at: number): Event => ({
  type: "InvocationCancelled",
  invocation,
  at
}) as Event

const invocationOf = (event: Event): ActorInvocation | undefined =>
  (event as { readonly invocation?: ActorInvocation }).invocation

const method = () => actorMethod({
  input: Schema.Void,
  output: Schema.Void,
  event: ({ invocation, at }) => started(invocation, at),
  state: () => ({ status: "pending" }),
  cancellation: {
    state: (events, invocation) => {
      if (!events.some((event) => event.type === "InvocationStarted" &&
        invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))) return undefined
      if (events.some((event) => event.type === "InvocationCancelled" &&
        invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))) return "cancelled"
      return "running"
    },
    event: (request, at) => cancelled(request.invocation, at)
  }
})

const methods = { message: method(), inspect: method() }

const request = (id: string, invocation: ActorInvocation, at: number): Event => ({
  type: "CancellationRequested",
  request: id,
  invocation,
  cause: "requested",
  at
}) as Event

const terminalKeyOf = (event: Event): string | undefined => {
  if (event.type !== "InvocationCancelled") return cancellationKeys.keyOf(event)
  const invocation = invocationOf(event)!
  return `cancelled:${JSON.stringify([invocation.method, invocation.id, invocation.epoch])}`
}

describe("cancellation properties", () => {
  test("ExactRequestTarget and DuplicateRequestsAbsorb use method, id, and epoch", () => {
    const first = request("x1", parent, 4)
    const retry = request("x2", parent, 5)
    const next = request("x1", nextEpoch, 4)
    const otherMethod = request("x1", child, 4)

    expect(cancellationKeys.keyOf(first)).toBe(cancellationKeys.keyOf(retry))
    expect(cancellationKeys.keyOf(first)).not.toBe(cancellationKeys.keyOf(next))
    expect(cancellationKeys.keyOf(first)).not.toBe(cancellationKeys.keyOf(otherMethod))
    expect(invocations.map((invocation) => cancelsInvocation(first, invocation)))
      .toEqual([true, false, false])

    const events = [
      ...invocations.map((invocation, index) => started(invocation, index + 1)),
      first,
      retry
    ]
    const transitions = cancellationTransitionsOf(events, methods, [], terminalKeyOf)
    expect(transitions?.map((transition) => transition.key)).toEqual([
      `cancelled:${JSON.stringify([parent.method, parent.id, parent.epoch])}`
    ])
  })

  test("NoNewEffects and OldEffectsSignalled isolate the requested invocation", () => {
    const runtime = actorFromReactors([() => invocations.map((invocation) => effect({
      key: `effect:${invocation.method}/${invocation.id}/${invocation.epoch}`,
      invocation,
      input: undefined,
      act: () => Effect.succeed([])
    }))], () => undefined, (events, invocation) => events.some((event) =>
      event.type === "InvocationStarted" && invocationOf(event) !== undefined &&
      sameInvocation(invocationOf(event)!, invocation)
    ) ? "running" : undefined)
    const cancellation = request("x1", parent, 4)
    const log = [...invocations.map((invocation, index) => started(invocation, index + 1)), cancellation]

    expect(enabled(runtime, log).map((transition) => transition.key)).toEqual([
      "effect:message/m1/1",
      "effect:inspect/m1/0"
    ])

    const interruptions = effectInterruptionRegistry()
    const parentEffect = new AbortController()
    const nextEffect = new AbortController()
    interruptions.register((event) => cancelsInvocation(event, parent), parentEffect)
    interruptions.register((event) => cancelsInvocation(event, nextEpoch), nextEffect)
    interruptions.interrupt([cancellation])
    expect(parentEffect.signal.aborted).toBe(true)
    expect(nextEffect.signal.aborted).toBe(false)
  })

  test("OpenCallsTerminated and InvocationCancelledLast wait for exact obligations", () => {
    const terminateCall = intent({
      key: "call:m1/terminate",
      input: undefined,
      events: (_input, at) => [{ type: "CallTerminated", invocation: parent, at } as Event]
    })
    const component: Component<undefined> = {
      name: "calls",
      cancel: (events, cancellation) => sameInvocation(cancellation.invocation, parent) &&
        !events.some((event) => event.type === "CallTerminated") ? [terminateCall] : [],
      derive: () => ({ view: undefined, transitions: [] })
    }
    const initial = [started(parent, 1), request("x1", parent, 2)]

    expect(cancellationTransitionsOf(initial, methods, [component], terminalKeyOf))
      .toEqual([terminateCall])
    expect(cancellationTransitionsOf([
      ...initial,
      { type: "CallTerminated", invocation: parent, at: 3 } as Event
    ], methods, [component], terminalKeyOf)?.map((transition) => transition.key)).toEqual([
      `cancelled:${JSON.stringify([parent.method, parent.id, parent.epoch])}`
    ])
  })

  test("ChildrenCancelled follows only InvocationLinked edges from the exact parent", () => {
    const links: ReadonlyArray<Event> = [
      {
        type: "InvocationLinked",
        parent,
        child: { invocation: child, parent },
        target: "worker:main:child",
        at: 2
      } as Event,
      {
        type: "InvocationLinked",
        parent: nextEpoch,
        child: { invocation: parent, parent: nextEpoch },
        target: "worker:main:next-child",
        at: 3
      } as Event
    ]
    const initial = [started(parent, 1), ...links, request("x1", parent, 4)]
    const childRequest = `cancel/x1/${child.method}/${child.id}/${child.epoch}`

    expect(cancellationTransitionsOf(initial, methods, [], terminalKeyOf)
      ?.map((transition) => transition.key)).toEqual([`cxsend:${childRequest}`])
    expect(cancellationTransitionsOf([
      ...initial,
      {
        type: "ResponseReceived",
        id: "child.cancelled",
        method: "$cancel",
        call: childRequest,
        status: "completed",
        output: { cancelled: true },
        from: "worker:main:child",
        at: 5
      } as Event
    ], methods, [], terminalKeyOf)?.map((transition) => transition.key)).toEqual([
      `cancelled:${JSON.stringify([parent.method, parent.id, parent.epoch])}`
    ])
  })
})
