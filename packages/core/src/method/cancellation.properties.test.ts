import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import fc from "fast-check"
import type { Event } from "@clavia/tardigrade-core/event"
import { effect } from "@clavia/tardigrade-core/effect"
import { intent } from "@clavia/tardigrade-core/intent"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import {
  actorFromProjections,
  effectInterruptionRegistry,
  enabled,
  type Actor,
  type ActorProjection
} from "../runtime"
import { completeTransitionProjection, type CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import { legacyComponent, type Component } from "@clavia/tardigrade-core/component"
import type { ActorInvocation } from "./call"
import {
  actorMethod,
  cancellationStateOf,
  initialMethodStates,
  reduceMethodStates,
  type ActorMethodDeclaration,
  type ActorMethods
} from "./method"
import { legacyActorMethod } from "./legacy"
import {
  actorCancellationProjection,
  cancellationMethodFor,
  cancellationKeys,
  cancellationTransitionsOf,
  cancelsInvocation
} from "./cancellation"
import {
  alarmFired,
  initialMethodTimeoutState,
  methodTimeoutTransitions,
  reduceMethodTimeoutState
} from "./timeout"

const actorFromCompleteDerivations = <R = never>(
  derivations: ReadonlyArray<CompleteTransitionDerivation<R>>,
  keyOf: Actor<R>["keyOf"],
  cancellationOf?: Actor<R>["cancellationOf"],
  cancellationResiduals?: Actor<R>["cancellationResiduals"],
  guards?: ReadonlyArray<CompleteTransitionDerivation<R>>,
  projection?: ActorProjection<R>
) => actorFromProjections({
  transitions: derivations.map(completeTransitionProjection),
  keyOf,
  ...(guards === undefined ? {} : { guards: guards.map(completeTransitionProjection) }),
  ...(projection === undefined ? {} : { control: projection }),
  ...(cancellationOf === undefined && cancellationResiduals === undefined
    ? {}
    : {
      legacy: {
        ...(cancellationOf === undefined ? {} : { cancellationOf }),
        ...(cancellationResiduals === undefined ? {} : { cancellationResiduals })
      }
    })
})

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
  projection: {
    initial: () => ({ started: new Set<string>(), cancelled: new Set<string>() }),
    step: (state, event) => {
      const started = new Set(state.started)
      const cancelled = new Set(state.cancelled)
      const invocation = invocationOf(event)
      if (invocation === undefined) return { started, cancelled }
      if (event.type === "InvocationStarted") started.add(JSON.stringify(invocation))
      if (event.type === "InvocationCancelled") cancelled.add(JSON.stringify(invocation))
      return { started, cancelled }
    },
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const key = JSON.stringify(invocation)
        if (!state.started.has(key)) return undefined
        return state.cancelled.has(key)
          ? { status: "cancelled" as const, cause: "requested" as const }
          : { status: "pending" as const }
      }
    })
  },
  cancellation: {
    event: (request, at) => cancelled(request.invocation, at)
  }
})

const projectedMethod = (options: {
  readonly cancellationState: boolean
  readonly cancellationEvent: boolean
}): ActorMethodDeclaration => {
  const projection = {
    initial: () => ({ started: new Set<string>(), cancelled: new Set<string>() }),
    step: (state: { readonly started: ReadonlySet<string>; readonly cancelled: ReadonlySet<string> }, event: Event) => {
      const invocation = invocationOf(event)
      if (invocation === undefined) return state
      const key = JSON.stringify(invocation)
      if (event.type === "InvocationStarted") return { ...state, started: new Set([...state.started, key]) }
      if (event.type === "InvocationCancelled") return { ...state, cancelled: new Set([...state.cancelled, key]) }
      return state
    },
    output: (state: { readonly started: ReadonlySet<string>; readonly cancelled: ReadonlySet<string> }) => ({
      currentEpoch: () => 0,
      invocationState: (invocation: ActorInvocation) => {
        const key = JSON.stringify(invocation)
        if (!state.started.has(key)) return undefined
        return state.cancelled.has(key)
          ? { status: "cancelled" as const, cause: "requested" as const }
          : { status: "pending" as const }
      },
      ...(options.cancellationState
        ? {
          cancellationState: (invocation: ActorInvocation) => {
            const key = JSON.stringify(invocation)
            if (!state.started.has(key)) return undefined
            return state.cancelled.has(key) ? "cancelled" as const : "running" as const
          }
        }
        : {})
    })
  }
  const definition = {
    input: Schema.Void,
    output: Schema.Void,
    event: ({ invocation, at }: { readonly invocation: ActorInvocation; readonly at: number }) => started(invocation, at),
    projection
  }
  return options.cancellationEvent
    ? actorMethod({ ...definition, cancellation: { event: (current, at) => cancelled(current.invocation, at) } })
    : actorMethod(definition)
}

const legacyCancellationMethod = () => legacyActorMethod({
  input: Schema.Void,
  output: Schema.Void,
  event: ({ invocation, at }) => started(invocation, at),
  state: (events, invocation) => {
    if (!events.some((event) => event.type === "InvocationStarted" &&
      invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))) return undefined
    return events.some((event) => event.type === "InvocationCancelled" &&
      invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))
      ? { status: "cancelled", cause: "requested" }
      : { status: "pending" }
  },
  cancellation: {
    state: (events, invocation) => {
      if (!events.some((event) => event.type === "InvocationStarted" &&
        invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))) return undefined
      return events.some((event) => event.type === "InvocationCancelled" &&
        invocationOf(event) !== undefined && sameInvocation(invocationOf(event)!, invocation))
        ? "cancelled"
        : "running"
    },
    event: (current, at) => cancelled(current.invocation, at)
  }
})

const methods: ActorMethods = { message: method(), inspect: method() }

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
  test("legacy and projected declarations normalize to one cancellation capability", () => {
    const cases = [
      { name: "legacy only", method: legacyCancellationMethod(), cancellable: true },
      {
        name: "projected state only",
        method: projectedMethod({ cancellationState: true, cancellationEvent: false }),
        cancellable: false
      },
      {
        name: "projected state and event",
        method: projectedMethod({ cancellationState: true, cancellationEvent: true }),
        cancellable: true
      },
      {
        name: "neither",
        method: projectedMethod({ cancellationState: false, cancellationEvent: false }),
        cancellable: false
      }
    ] as const
    const head = {
      ...started(parent, 1),
      call: { invocation: parent, deadlineAt: 10 }
    } as Event
    const cancellation = request("x1", parent, 2)
    const alarm = alarmFired({ scheduledFor: 10, at: 10 })
    const linked = {
      type: "InvocationLinked",
      parent,
      child: { invocation: child, parent },
      target: "worker:main:child",
      at: 2
    } as Event

    for (const current of cases) {
      const methods = { message: current.method }
      const control = actorCancellationProjection(methods, [], terminalKeyOf)!
      const controlState = [head, cancellation].reduce(control.step, control.initial())
      expect(control.output(controlState).residuals?.map((transition) => transition.key), current.name)
        .toEqual(current.cancellable
          ? [`cancelled:${JSON.stringify([parent.method, parent.id, parent.epoch])}`]
          : undefined)
      const linkedState = [head, linked, cancellation].reduce(control.step, control.initial())
      expect(control.output(linkedState).residuals?.map((transition) => transition.key), current.name)
        .toEqual(current.cancellable ? ["cxsend:cancel/x1/inspect/m1/0"] : undefined)

      const cancelMethod = cancellationMethodFor(methods)
      const cancelInvocation = { method: "$cancel", id: "x1", epoch: 0 }
      const accepted = replayProjection(cancelMethod.projection, [head, cancellation]).invocationState(cancelInvocation)
      expect(accepted, current.name).toEqual(current.cancellable
        ? { status: "pending" }
        : { status: "failed", error: 'method "message" is not cancellable' })
      const completed = replayProjection(cancelMethod.projection, [head, cancellation, cancelled(parent, 3)])
        .invocationState(cancelInvocation)
      expect(completed, current.name).toEqual(current.cancellable
        ? { status: "completed", output: { cancelled: true } }
        : { status: "failed", error: 'method "message" is not cancellable' })

      let methodStates = initialMethodStates(methods)
      let timeoutState = initialMethodTimeoutState()
      for (const event of [head, alarm]) {
        methodStates = reduceMethodStates(methods, methodStates, event)
        timeoutState = reduceMethodTimeoutState(timeoutState, event)
      }
      expect(methodTimeoutTransitions(methods, methodStates, timeoutState).map((transition) => transition.key), current.name)
        .toEqual(current.cancellable ? [`cx:${JSON.stringify([parent.method, parent.id, parent.epoch])}`] : [])
    }
  })

  test("the control projection agrees with complete cancellation replay", () => {
    const projection = actorCancellationProjection(methods, [], terminalKeyOf)!
    const legacy = actorFromCompleteDerivations(
      [],
      terminalKeyOf,
      (events, invocation) => {
        const method = methods[invocation.method]
        return method === undefined
          ? undefined
          : cancellationStateOf(method, replayProjection(method.projection, events), invocation)
      },
      (events) => cancellationTransitionsOf(events, methods, [], terminalKeyOf)
    )
    const incremental = actorFromCompleteDerivations(
      [],
      terminalKeyOf,
      legacy.cancellationOf,
      legacy.cancellationResiduals,
      undefined,
      projection
    )
    const childRequest = "cancel/x1/inspect/m1/0"
    const candidates: ReadonlyArray<Event> = [
      started(parent, 1),
      started(nextEpoch, 2),
      request("x1", parent, 3),
      request("x2", parent, 4),
      cancelled(parent, 5),
      {
        type: "InvocationLinked",
        parent,
        child: { invocation: child, parent },
        target: "worker:main:child",
        at: 6
      } as Event,
      { type: "ResponseReceived", method: "inspect", call: "m1", at: 7 } as Event,
      { type: "CancellationDispatched", request: childRequest, at: 8 } as Event,
      { type: "ResponseReceived", method: "$cancel", call: childRequest, at: 9 } as Event
    ]

    fc.assert(fc.property(
      fc.array(fc.integer({ min: 0, max: candidates.length - 1 }), { maxLength: 40 }),
      (indices) => {
        const events = indices.map((index) => candidates[index]!)
        expect(enabled(incremental, events).map((transition) => transition.key))
          .toEqual(enabled(legacy, events).map((transition) => transition.key))
      }
    ))
  })

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
    const runtime = actorFromCompleteDerivations([() => invocations.map((invocation) => effect({
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
    const component: Component<undefined> = legacyComponent({
      name: "calls",
      cancel: (events, cancellation) => sameInvocation(cancellation.invocation, parent) &&
        !events.some((event) => event.type === "CallTerminated") ? [terminateCall] : [],
      derive: () => ({ view: undefined, transitions: [] })
    })
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

  test("ChildrenCancelled follows InvocationLinked edges from the logical parent across epochs", () => {
    // A link records its parent at the spawn epoch, while a cancellation request names the
    // parent's current epoch, so edge matching is logical: method and id, never epoch.
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

    const nextChildRequest = `cancel/x1/${parent.method}/${parent.id}/${parent.epoch}`
    expect(cancellationTransitionsOf(initial, methods, [], terminalKeyOf)
      ?.map((transition) => transition.key))
      .toEqual([`cxsend:${childRequest}`, `cxsend:${nextChildRequest}`])
    const childAnswered = [
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
    ]
    expect(cancellationTransitionsOf(childAnswered, methods, [], terminalKeyOf)
      ?.map((transition) => transition.key)).toEqual([`cxsend:${nextChildRequest}`])
    expect(cancellationTransitionsOf([
      ...childAnswered,
      {
        type: "ResponseReceived",
        id: "next-child.cancelled",
        method: "$cancel",
        call: nextChildRequest,
        status: "completed",
        output: { cancelled: true },
        from: "worker:main:next-child",
        at: 6
      } as Event
    ], methods, [], terminalKeyOf)?.map((transition) => transition.key)).toEqual([
      `cancelled:${JSON.stringify([parent.method, parent.id, parent.epoch])}`
    ])
  })
})
