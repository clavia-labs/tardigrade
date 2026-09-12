import { CancellationRequested, CancellationInput, CancellationResult, type CancellationDispatched, type InvocationCancellation } from "./events"
import { Cause, Clock, Effect, Schema } from "effect"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { bindTransitionContext, transitionKeyOf } from "../transition/transition"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { EventLog } from "../log"
import { Self } from "../runtime/context"
import type { ActorProjection } from "../runtime/definition"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/keys"
import { formatThreadAddress, parseThreadAddress } from "../transport/endpoint"
import { Router } from "../transport/router"
import type { ThreadLineage } from "./relations"
import { cancelComponent, type Component } from "@clavia/tardigrade-core/component"
import { InvocationRef, invocationKey, sameInvocation, invocationCoordinateKey, type InvocationCoordinate } from "./invocation"
import { actorMethod, type ActorMethodDeclaration, type ActorMethods } from "../actor/method"
import { cancellationStateOf, initialMethodStates, reduceMethodStates, type ActorMethodCancellationState } from "./state"

import { invocationTerminalOf, terminalInvocationRefOf } from "./result"
import { sendInvocation } from "./send"

// TODO: Split cancellation state projection, request protocol, and transition construction into separate modules.

// DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS bounds how long a parent waits for a child cancellation response.
export const DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS = 30_000

// childCancellationTimeoutOf resolves and validates the actor's child cancellation timeout.
export const childCancellationTimeoutOf = (timeoutMs: number | undefined): number => {
  const resolved = timeoutMs ?? DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error("child cancellation timeoutMs must be a positive safe integer")
  }
  return resolved
}

export const CANCELLATION_CONTROL_METHOD = "$cancel"

export type CancellationDisposition = "requestable" | "requested" | "cancelled" | "settled"

export const cancellationKeys: KeyFragment = {
  prefixes: ["cx:", "cxsend:"],
  keyOf: (event) => {
    if (event.type === "CancellationDispatched") {
      return `cxsend:${String((event as { readonly request?: unknown }).request)}`
    }
    const cancellation = cancellationRequestedOf(event)
    return cancellation === undefined
      ? undefined
      : `cx:${JSON.stringify([
          cancellation.invocation.method,
          cancellation.invocation.id,
          cancellation.invocation.epoch
        ])}`
  }
}

// cancellationRequested constructs the core control event for one invocation.
export const cancellationRequested = (fields: Omit<CancellationRequested, "type">): Event =>
  ({ type: "CancellationRequested", ...fields }) as Event

// cancellationRequestedOf decodes the cancellation carried by a core control event.
export const cancellationRequestedOf = (event: Event): InvocationCancellation | undefined => {
  const candidate = { ...event, at: 0 }
  if (!Schema.is(CancellationRequested)(candidate)) return undefined
  return {
    request: candidate.request,
    invocation: candidate.invocation,
    cause: candidate.cause,
    ...(candidate.reason === undefined ? {} : { reason: candidate.reason }),
    ...(candidate.deadlineAt === undefined ? {} : { deadlineAt: candidate.deadlineAt })
  }
}

// cancelsInvocation reports whether an event requests cancellation of the exact invocation epoch.
export const cancelsInvocation = (event: Event, invocation: InvocationRef): boolean => {
  const cancellation = cancellationRequestedOf(event)
  return cancellation !== undefined &&
    cancellation.invocation.method === invocation.method &&
    cancellation.invocation.id === invocation.id &&
    cancellation.invocation.epoch === invocation.epoch
}

// cancellationDispositionOf reports how cancellation applies to the current invocation state.
export const cancellationDispositionOf = (
  events: ReadonlyArray<Event>,
  method: ActorMethodDeclaration,
  invocation: InvocationRef
): CancellationDisposition | undefined => {
  const state = cancellationStateOf(method, replayProjection(method.projection, events), invocation)
  if (state === undefined) return undefined
  if (hasUnsettledInvocationChildren(events, invocation)) {
    return events.some((event) => cancelsInvocation(event, invocation)) ? "requested" : "requestable"
  }
  if (state === "cancelled") return "cancelled"
  if (state === "terminal") return "settled"
  return events.some((event) => cancelsInvocation(event, invocation)) ? "requested" : "requestable"
}

const methodCancellationOf = (methods: ActorMethods, cancellation: InvocationCancellation) =>
  methods[cancellation.invocation.method]

// cancellationRequestIdOf derives the durable cancellation identity from its target invocation.
export const cancellationRequestIdOf = (invocation: InvocationRef): string =>
  `cancel:${invocationKey(invocation)}`

const pendingCancellationsOf = (
  events: ReadonlyArray<Event>,
  methods: ActorMethods
): ReadonlyArray<{ readonly cancellation: InvocationCancellation; readonly event: Event }> => {
  const seen = new Set<string>()
  return events.flatMap((event, index) => {
    const cancellation = cancellationRequestedOf(event)
    if (cancellation === undefined) return []
    const method = methodCancellationOf(methods, cancellation)
    const before = method === undefined
      ? undefined
      : cancellationStateOf(method, replayProjection(method.projection, events.slice(0, index)), cancellation.invocation)
    const current = method === undefined
      ? undefined
      : cancellationStateOf(method, replayProjection(method.projection, events), cancellation.invocation)
    const pending = (current === "running" && (before === undefined || before === "running")) ||
      (method?.cancellation !== undefined && hasUnsettledInvocationChildren(events, cancellation.invocation))
    if (!pending) return []
    const key = invocationKey(cancellation.invocation)
    if (seen.has(key)) return []
    seen.add(key)
    return [{ cancellation, event }]
  })
}

const terminalTransitionOf = <R>(
  cancellation: InvocationCancellation,
  methods: ActorMethods,
  owner: Event
): Transition<never, R> => bindTransitionContext(owner, "actor.cancellations").intent("finish", (at) =>
  methodCancellationOf(methods, cancellation)!.cancellation!.event(cancellation, at), { invocation: null })

interface ChildCancellationLink {
  readonly owner: Event
  readonly reference: InvocationCoordinate
  readonly lineage?: ThreadLineage
}

const childLinkOf = (event: Event): ProjectedChildLink | undefined => {
  if (event.type !== "InvocationLinked") return undefined
  const link = event as {
    readonly parent?: InvocationRef
    readonly child?: { readonly invocation?: InvocationRef }
    readonly target?: unknown
    readonly lineage?: ThreadLineage
  }
  return link.parent !== undefined && link.child?.invocation !== undefined &&
    typeof link.target === "string"
    ? {
        owner: event,
        parent: link.parent,
        reference: { target: parseThreadAddress(link.target), invocation: link.child.invocation },
        ...(link.lineage === undefined ? {} : { lineage: link.lineage })
      }
    : undefined
}

const childLinksOf = (
  events: ReadonlyArray<Event>,
  parent: InvocationRef
): ReadonlyArray<ChildCancellationLink> => events.flatMap((event) => {
  const link = childLinkOf(event)
  return link !== undefined && sameInvocation(link.parent, parent) ? [link] : []
})

const childCancellationRef = (cancellation: InvocationCancellation, reference: InvocationCoordinate): InvocationCoordinate => ({
  target: reference.target,
  invocation: {
    method: CANCELLATION_CONTROL_METHOD,
    id: `cancel:${JSON.stringify([cancellation.request, formatThreadAddress(reference.target), reference.invocation.method, reference.invocation.id, reference.invocation.epoch])}`,
    epoch: 0
  }
})

// hasUnsettledInvocationChildren retains cancellation after an owner returns (cancellation.test.ts).
export const hasUnsettledInvocationChildren = (events: ReadonlyArray<Event>, parent: InvocationRef): boolean => {
  const requests = events.flatMap((event) => {
    const request = cancellationRequestedOf(event)
    return request !== undefined && sameInvocation(request.invocation, parent) ? [request] : []
  })
  return childLinksOf(events, parent).some(({ reference }) =>
    invocationTerminalOf(events, reference) === undefined &&
    !requests.some((request) => invocationTerminalOf(events, childCancellationRef(request, reference)) !== undefined))
}

// unsettledInvocationParentsOf lists the parent invocations whose linked families remain open.
export const unsettledInvocationParentsOf = (
  events: ReadonlyArray<Event>
): ReadonlyArray<InvocationRef> => {
  const parents = new Map<string, InvocationRef>()
  for (const event of events) {
    const link = childLinkOf(event)
    if (link !== undefined && invocationTerminalOf(events, link.reference) === undefined) {
      parents.set(invocationKey(link.parent), link.parent)
    }
  }
  return [...parents.values()]
}

const childCancellationTransitions = <R>(
  children: ReadonlyArray<ChildCancellationLink>,
  cancellation: InvocationCancellation,
  timeoutMs: number,
  dispositionOf: (reference: InvocationCoordinate, cancel: InvocationCoordinate) => "done" | "dispatched" | "ready"
): ReadonlyArray<Transition<never, R | Router | Self>> => children.flatMap(({ reference, lineage, owner }) => {
    const context = bindTransitionContext(owner, "actor.cancellations")
    const child = reference.invocation
    const cancel = childCancellationRef(cancellation, reference)
    const disposition = dispositionOf(reference, cancel)
    if (disposition === "done") return []
    return [context.effect(disposition === "ready" ? "cancel" : "wait", {
      invocation: null,
      input: { cancel, child, cancellation, lineage },
      act: (input) => Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        const events: CancellationDispatched[] = []
        if (disposition === "ready") {
          const deadlineAt = at + timeoutMs
          if (!Number.isSafeInteger(deadlineAt)) {
            throw new Error("child cancellation deadlineAt must be a safe integer")
          }
          events.push({
            type: "CancellationDispatched",
            reference: input.cancel,
            request: input.cancel.invocation.id,
            invocation: input.child,
            target: formatThreadAddress(input.cancel.target),
            timeoutMs,
            deadlineAt,
            at
          })
          const log = yield* EventLog
          yield* log.append(events)
        }
        yield* sendInvocation({
          target: input.cancel.target,
          context: { invocation: input.cancel.invocation },
          event: cancellationRequested({
            request: input.cancel.invocation.id,
            invocation: input.child,
            cause: input.cancellation.cause,
            ...(input.cancellation.reason === undefined ? {} : { reason: input.cancellation.reason }),
            ...(input.cancellation.deadlineAt === undefined ? {} : { deadlineAt: input.cancellation.deadlineAt }),
            at
          }),
          ...(input.lineage === undefined ? {} : { lineage: input.lineage })
        }).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Child cancellation delivery failed", cause)))
        return events
      })
    })]
  }) as ReadonlyArray<Transition<never, R | Router | Self>>

const childCancellationTransitionsOf = <R>(
  events: ReadonlyArray<Event>,
  cancellation: InvocationCancellation,
  timeoutMs: number
): ReadonlyArray<Transition<never, R | Router | Self>> => childCancellationTransitions<R>(
  childLinksOf(events, cancellation.invocation),
  cancellation,
  timeoutMs,
  (reference, cancel) => {
    if (invocationTerminalOf(events, reference) !== undefined ||
      invocationTerminalOf(events, cancel) !== undefined) return "done"
    return events.some((event) =>
      event.type === "CancellationDispatched" &&
      String((event as { readonly request?: unknown }).request) === cancel.invocation.id
    ) ? "dispatched" : "ready"
  }
)

interface ProjectedCancellationRecord {
  readonly event: Event
  readonly cancellation: InvocationCancellation
  readonly accepted: ActorMethodCancellationState | undefined
}

interface ProjectedChildLink extends ChildCancellationLink {
  readonly parent: InvocationRef
}

interface ActorCancellationProjectionState {
  readonly methods: ReadonlyMap<string, unknown>
  readonly components: ReadonlyArray<unknown>
  readonly requests: ReadonlyArray<ProjectedCancellationRecord>
  readonly links: ReadonlyArray<ProjectedChildLink>
  readonly settledCalls: ReadonlySet<string>
  readonly dispatchedCancellations: ReadonlySet<string>
  readonly recorded: ReadonlySet<string>
}

const projectedChildSettled = (state: { readonly settledCalls: ReadonlySet<string>; readonly requests: ReadonlyArray<{ readonly cancellation: InvocationCancellation }> }, link: ProjectedChildLink): boolean =>
  state.settledCalls.has(invocationCoordinateKey(link.reference)) || state.requests.some(({ cancellation }) =>
    sameInvocation(cancellation.invocation, link.parent) &&
    state.settledCalls.has(invocationCoordinateKey(childCancellationRef(cancellation, link.reference))))

// actorCancellationMethodStates exposes the method states owned by the actor control projection.
export const actorCancellationMethodStates = (state: unknown): ReadonlyMap<string, unknown> =>
  (state as ActorCancellationProjectionState).methods

// actorCancellationComponentTransitions derives ordinary component work from actor control state.
export const actorCancellationComponentTransitions = <R>(
  state: unknown,
  components: ReadonlyArray<Component<unknown, R>>
): ReadonlyArray<Transition<never, R>> => {
  const projected = state as ActorCancellationProjectionState
  return components.flatMap((component, index) => component.machine.output(projected.components[index]).transitions)
}

const projectedChildCancellationTransitionsOf = <R>(
  state: ActorCancellationProjectionState,
  cancellation: InvocationCancellation,
  timeoutMs: number
): ReadonlyArray<Transition<never, R | Router | Self>> => childCancellationTransitions<R>(
  state.links.filter((link) => sameInvocation(link.parent, cancellation.invocation)),
  cancellation,
  timeoutMs,
  (reference, cancel) =>
    state.settledCalls.has(invocationCoordinateKey(reference)) || state.settledCalls.has(invocationCoordinateKey(cancel))
      ? "done"
      : state.dispatchedCancellations.has(cancel.invocation.id) ? "dispatched" : "ready"
)

// actorCancellationProjection constructs the control-plane quotient from method and component projections.
export const actorCancellationProjection = <R>(
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS
): ActorProjection<R | Router | Self> | undefined => {
  const timeoutMs = childCancellationTimeoutOf(childTimeoutMs)
  const initial = (): ActorCancellationProjectionState => ({
    methods: initialMethodStates(methods),
    components: components.map((component) => component.machine.initial()),
    requests: [],
    links: [],
    settledCalls: new Set(),
    dispatchedCancellations: new Set(),
    recorded: new Set()
  })
  const reduce = (state: ActorCancellationProjectionState, event: Event): ActorCancellationProjectionState => {
    const request = cancellationRequestedOf(event)
    const requests = request === undefined
      ? state.requests
      : [...state.requests, {
          event,
          cancellation: request,
          accepted: methods[request.invocation.method] === undefined
            ? undefined
            : cancellationStateOf(
                methods[request.invocation.method],
                methods[request.invocation.method]!.projection.output(state.methods.get(request.invocation.method)),
                request.invocation
              )
        }]
    const methodsState = reduceMethodStates(methods, state.methods, event)
    const componentsState = components.map((component, index) =>
      component.machine.step(state.components[index], event)
    )
    const links = [...state.links]
    const link = childLinkOf(event)
    if (link !== undefined) links.push(link)
    const settledCalls = new Set(state.settledCalls)
    const terminal = terminalInvocationRefOf(event)
    if (terminal !== undefined) settledCalls.add(invocationCoordinateKey(terminal))
    const dispatchedCancellations = new Set(state.dispatchedCancellations)
    if (event.type === "CancellationDispatched") {
      dispatchedCancellations.add(String((event as { readonly request?: unknown }).request))
    }
    const recorded = new Set(state.recorded)
    const key = transitionKeyOf(event) ?? keyOf(event)
    if (key !== undefined) recorded.add(key)
    return {
      methods: methodsState,
      components: componentsState,
      requests,
      links,
      settledCalls,
      dispatchedCancellations,
      recorded
    }
  }
  const cancellationOf = (state: ActorCancellationProjectionState, invocation: InvocationRef) =>
    methods[invocation.method] === undefined
      ? undefined
      : cancellationStateOf(
          methods[invocation.method],
          methods[invocation.method]!.projection.output(state.methods.get(invocation.method)),
          invocation
        )
  const pending = (state: ActorCancellationProjectionState): ReadonlyArray<ProjectedCancellationRecord> => {
    const seen = new Set<string>()
    const result: Array<ProjectedCancellationRecord> = []
    for (const record of state.requests) {
      const invocation = record.cancellation.invocation
      const current = cancellationOf(state, invocation)
      if (methods[invocation.method]?.cancellation === undefined) continue
      if ((current !== "running" || (record.accepted !== undefined && record.accepted !== "running")) &&
        !state.links.some((link) => sameInvocation(link.parent, invocation) && !projectedChildSettled(state, link))) continue
      const key = invocationKey(invocation)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(record)
    }
    return result
  }
  const residuals = (state: ActorCancellationProjectionState) => {
    const cancellations = pending(state)
    if (cancellations.length === 0) return undefined
    const terminals: Array<Transition<never, R | Router | Self>> = []
    const obligations: Array<Transition<never, R | Router | Self>> = []
    for (const { cancellation, event } of cancellations) {
      const child = projectedChildCancellationTransitionsOf<R>(state, cancellation, timeoutMs)
      const component = components.flatMap((entry, index) =>
        entry.machine.cancel?.(state.components[index], cancellation) ?? []
      )
      const outstanding = [...child, ...component].filter((transition) => !state.recorded.has(transition.key))
      if (outstanding.length === 0 && cancellationOf(state, cancellation.invocation) === "running") terminals.push(terminalTransitionOf(cancellation, methods, event))
      else obligations.push(...outstanding)
    }
    return [...terminals, ...obligations]
  }
  return {
    initial,
    step: (state, event) => reduce(state as ActorCancellationProjectionState, event),
    output: (erased) => {
      const state = erased as ActorCancellationProjectionState
      return {
        continuations: [],
        cancellationOf: (invocation: InvocationRef) => cancellationOf(state, invocation),
        suppresses: (invocation: InvocationRef) => state.requests.some((record) =>
          sameInvocation(record.cancellation.invocation, invocation) &&
          (record.accepted === "running" || cancellationOf(state, invocation) === "running")
        ),
        residuals: residuals(state)
      }
    }
  }
}

// cancellationTransitionsOf projects independent component cleanup and method terminals for pending invocations.
export const cancellationTransitionsOf = <R>(
  history: ReadonlyArray<Event>,
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS
): ReadonlyArray<Transition<never, R | Router | Self>> | undefined => {
  const timeoutMs = childCancellationTimeoutOf(childTimeoutMs)
  const events = history.map((event, index) => eventPositionOf(event) === undefined ? eventAt(event, index + 1) : event)
  const cancellations = pendingCancellationsOf(events, methods)
  if (cancellations.length === 0) return undefined
  const recorded = new Set(events.flatMap((event) => {
    const key = transitionKeyOf(event) ?? keyOf(event)
    return key === undefined ? [] : [key]
  }))
  const terminals: Array<Transition<never, R | Router | Self>> = []
  const obligations: Array<Transition<never, R | Router | Self>> = []
  for (const { cancellation, event } of cancellations) {
    const pending = [
      ...childCancellationTransitionsOf<R>(events, cancellation, timeoutMs),
      ...components.flatMap((component) => cancelComponent(component, events, cancellation))
    ]
      .filter((transition) => !recorded.has(transition.key))
    if (pending.length === 0) {
      const method = methodCancellationOf(methods, cancellation)
      if (method !== undefined && cancellationStateOf(method, replayProjection(method.projection, events), cancellation.invocation) === "running") {
        terminals.push(terminalTransitionOf(cancellation, methods, event))
      }
    } else {
      obligations.push(...pending)
    }
  }
  return [...terminals, ...obligations]
}

// cancellationMethodFor constructs the internal control method paired with an actor's cancellable methods.
interface CancellationMethodState {
  readonly links: ReadonlyArray<ProjectedChildLink>
  readonly settledCalls: ReadonlySet<string>
  readonly methods: ReadonlyMap<string, unknown>
  readonly requests: ReadonlyMap<string, {
    readonly cancellation: InvocationCancellation
    readonly accepted: ActorMethodCancellationState | undefined
  }>
}

const cancellationMethodState = (
  target: InvocationRef,
  cancellable: boolean,
  accepted: ActorMethodCancellationState | undefined,
  current: ActorMethodCancellationState | undefined,
  hasChildren = false
) => {
  if (!cancellable) return { status: "failed" as const, error: `method ${JSON.stringify(target.method)} is not cancellable` }
  if (accepted === undefined) return { status: "failed" as const, error: `invocation ${JSON.stringify(target.id)} does not exist` }
  if (hasChildren) return { status: "pending" as const }
  if (accepted === "terminal") return { status: "completed" as const, output: { cancelled: false } }
  if (accepted === "cancelled") return { status: "completed" as const, output: { cancelled: true } }
  if (current === "running") return { status: "pending" as const }
  return { status: "completed" as const, output: { cancelled: current === "cancelled" } }
}

// cancellationMethodStateOf derives the control method state from the actor control projection.
export const cancellationMethodStateOf = (
  methods: ActorMethods,
  state: unknown,
  invocation: InvocationRef
) => {
  const projected = state as ActorCancellationProjectionState
  const record = projected.requests.find((entry) => entry.cancellation.request === invocation.id)
  if (record === undefined) return undefined
  const target = record.cancellation.invocation
  const method = methods[target.method]
  const current = method === undefined
    ? undefined
    : cancellationStateOf(
        method,
        method.projection.output(projected.methods.get(target.method)),
        target
      )
  return cancellationMethodState(target, method?.cancellation !== undefined, record.accepted, current, projected.links.some((link) => sameInvocation(link.parent, target) && !projectedChildSettled(projected, link)))
}

export const cancellationMethodFor = (methods: ActorMethods) => actorMethod({
  input: CancellationInput,
  output: CancellationResult,
  event: ({ invocation, input, at }) => cancellationRequested({
    request: invocation.id,
    invocation: input.invocation,
    cause: "requested",
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    at
  }),
  projection: {
    initial: (): CancellationMethodState => ({
      links: [],
      settledCalls: new Set(),
      methods: initialMethodStates(methods),
      requests: new Map()
    }),
    step: (state, event): CancellationMethodState => {
      const requests = new Map(state.requests)
      const request = cancellationRequestedOf(event)
      if (request !== undefined && !requests.has(request.request)) {
        const method = methods[request.invocation.method]
        requests.set(request.request, {
          cancellation: request,
          accepted: method === undefined
            ? undefined
            : cancellationStateOf(
                method,
                method.projection.output(state.methods.get(request.invocation.method)),
                request.invocation
              )
        })
      }
      const link = childLinkOf(event)
      const terminal = terminalInvocationRefOf(event)
      return {
        links: link === undefined ? state.links : [...state.links, link],
        settledCalls: terminal === undefined ? state.settledCalls : new Set([...state.settledCalls, invocationCoordinateKey(terminal)]),
        methods: reduceMethodStates(methods, state.methods, event),
        requests
      }
    },
    output: (state) => ({
      currentEpoch: () => 0,
      invocationState: (invocation) => {
        const record = state.requests.get(invocation.id)
        if (record === undefined) return undefined
        const target = record.cancellation.invocation
        const method = methods[target.method]
        const current = method === undefined
          ? undefined
          : cancellationStateOf(
              method,
              method.projection.output(state.methods.get(target.method)),
              target
            )
        return cancellationMethodState(
          target,
          method?.cancellation !== undefined,
          record.accepted,
          current,
          state.links.some((link) => sameInvocation(link.parent, target) && !projectedChildSettled({ settledCalls: state.settledCalls, requests: [...state.requests.values()] }, link))
        )
      }
    })
  }
})
