import { Clock, Effect, Schema } from "effect"
import { effect } from "@clavia/tardigrade-core/effect"
import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { Self, type ActorControlProjection } from "@clavia/tardigrade-core/runtime/reconciler"
import type { Transition } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../../log/keys"
import { methodEnvelopeOf } from "../../communication/envelope"
import { parseThreadAddress } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { Router } from "../../communication/router"
import type { ThreadLineage } from "../../thread"
import { cancelComponent, type Component } from "@clavia/tardigrade-core/component"
import { ActorInvocationSchema, type ActorInvocation } from "./call"
import {
  actorMethod,
  initialMethodStates,
  reduceMethodStates,
  type ActorMethodCancellationState,
  type ActorMethodDeclaration,
  type ActorMethods
} from "./definition"

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

export const InvocationCancellationCause = Schema.Literals(["requested", "deadline"])
export type InvocationCancellationCause = typeof InvocationCancellationCause.Type

// CancellationRequested records a request to stop one actor method invocation epoch.
export const CancellationRequested = Schema.Struct({
  type: Schema.Literal("CancellationRequested"),
  request: Schema.String,
  invocation: ActorInvocationSchema,
  cause: InvocationCancellationCause,
  reason: Schema.optional(Schema.String),
  deadlineAt: Schema.optional(Schema.Finite),
  at: Schema.Finite
})
export type CancellationRequested = typeof CancellationRequested.Type

export const CancellationInput = Schema.Struct({
  invocation: ActorInvocationSchema,
  reason: Schema.optionalKey(Schema.String)
}).annotate({ identifier: "CancellationInput" })
export type CancellationInput = typeof CancellationInput.Type

export const CancellationResult = Schema.Struct({
  cancelled: Schema.Boolean
}).annotate({ identifier: "CancellationResult" })
export type CancellationResult = typeof CancellationResult.Type

export const CANCELLATION_CONTROL_METHOD = "$cancel"

export type CancellationDisposition = "requestable" | "requested" | "cancelled" | "settled"

export interface CancellationDispatched extends Event {
  readonly type: "CancellationDispatched"
  readonly request: string
  readonly invocation: ActorInvocation
  readonly target: string
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

// InvocationCancellation carries one decoded cancellation request to method and component projections.
export interface InvocationCancellation {
  readonly request: string
  readonly invocation: ActorInvocation
  readonly cause: InvocationCancellationCause
  readonly reason?: string
  readonly deadlineAt?: number
}

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
export const cancelsInvocation = (event: Event, invocation: ActorInvocation): boolean => {
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
  invocation: ActorInvocation
): CancellationDisposition | undefined => {
  const state = method.cancellation?.state(events, invocation)
  if (state === undefined) return undefined
  if (state === "cancelled") return "cancelled"
  if (state === "terminal") return "settled"
  return events.some((event) => cancelsInvocation(event, invocation)) ? "requested" : "requestable"
}

const methodCancellationOf = (methods: ActorMethods, cancellation: InvocationCancellation) =>
  methods[cancellation.invocation.method]?.cancellation

const invocationKeyOf = (invocation: ActorInvocation): string =>
  JSON.stringify([invocation.method, invocation.id, invocation.epoch])

// cancellationRequestIdOf derives the durable cancellation identity from its target invocation.
export const cancellationRequestIdOf = (invocation: ActorInvocation): string =>
  `cancel:${invocationKeyOf(invocation)}`

const pendingCancellationsOf = (
  events: ReadonlyArray<Event>,
  methods: ActorMethods
): ReadonlyArray<InvocationCancellation> => {
  const seen = new Set<string>()
  return events.flatMap((event, index) => {
    const cancellation = cancellationRequestedOf(event)
    if (cancellation === undefined) return []
    const method = methodCancellationOf(methods, cancellation)
    const before = method?.state(events.slice(0, index), cancellation.invocation)
    const current = method?.state(events, cancellation.invocation)
    const pending = current === "running" && (before === undefined || before === "running")
    if (!pending) return []
    const key = invocationKeyOf(cancellation.invocation)
    if (seen.has(key)) return []
    seen.add(key)
    return [cancellation]
  })
}

const terminalTransitionOf = <R>(
  cancellation: InvocationCancellation,
  methods: ActorMethods,
  keyOf: (event: Event) => string | undefined
): Transition<never, R> => {
  const method = methodCancellationOf(methods, cancellation)!
  const sample = method.event(cancellation, 0)
  const key = keyOf(sample)
  if (key === undefined) {
    throw new Error(
      `cancellation terminal for method ${JSON.stringify(cancellation.invocation.method)} carries no committing key`
    )
  }
  return intent({
    key,
    input: cancellation,
    events: (input, at) => [method.event(input, at)]
  }) as Transition<never, R>
}

const sameInvocation = (left: ActorInvocation, right: ActorInvocation): boolean =>
  left.method === right.method && left.id === right.id && left.epoch === right.epoch

interface ChildCancellationLink {
  readonly child: ActorInvocation
  readonly target: string
  readonly lineage?: ThreadLineage
}

const childLinksOf = (
  events: ReadonlyArray<Event>,
  parent: ActorInvocation
): ReadonlyArray<ChildCancellationLink> => events.flatMap((event) => {
  if (event.type !== "InvocationLinked") return []
  const link = event as {
    readonly parent?: ActorInvocation
    readonly child?: { readonly invocation?: ActorInvocation }
    readonly target?: unknown
    readonly lineage?: ThreadLineage
  }
  return link.parent !== undefined && link.child?.invocation !== undefined &&
    sameInvocation(link.parent, parent) && typeof link.target === "string"
    ? [{
        child: link.child.invocation,
        target: link.target,
        ...(link.lineage === undefined ? {} : { lineage: link.lineage })
      }]
    : []
})

const callSettled = (events: ReadonlyArray<Event>, invocation: ActorInvocation): boolean =>
  events.some((event) =>
    event.type === "ResponseReceived" &&
      String((event as { readonly method?: unknown }).method) === invocation.method &&
      String((event as { readonly call?: unknown }).call) === invocation.id ||
    event.type === "CallTimedOut" &&
      String((event as { readonly method?: unknown }).method) === invocation.method &&
      String((event as { readonly call?: unknown }).call) === invocation.id
  )

const childCancellationTransitions = <R>(
  children: ReadonlyArray<ChildCancellationLink>,
  cancellation: InvocationCancellation,
  timeoutMs: number,
  dispositionOf: (child: ActorInvocation, request: string) => "done" | "dispatched" | "ready"
): ReadonlyArray<Transition<never, R | Router | Self>> => children.flatMap(({ child, target, lineage }) => {
    const request = `cancel/${cancellation.request}/${child.method}/${child.id}/${child.epoch}`
    const disposition = dispositionOf(child, request)
    if (disposition === "done") return []
    if (disposition === "dispatched") {
      return [effect({
        key: `cxwait:${request}`,
        input: undefined,
        act: () => Effect.succeed([])
      })]
    }
    return [effect({
      key: `cxsend:${request}`,
      input: { request, child, target, cancellation, lineage },
      act: (input) => Effect.gen(function* () {
        const router = yield* Router
        const self = yield* Self
        const at = yield* Clock.currentTimeMillis
        const deadlineAt = at + timeoutMs
        if (!Number.isSafeInteger(deadlineAt)) {
          throw new Error("child cancellation deadlineAt must be a safe integer")
        }
        yield* router.send(methodEnvelopeOf(
          linkOf(self, parseThreadAddress(input.target)),
          { invocation: { method: CANCELLATION_CONTROL_METHOD, id: input.request, epoch: 0 } },
          cancellationRequested({
            request: input.request,
            invocation: input.child,
            cause: input.cancellation.cause,
            ...(input.cancellation.reason === undefined ? {} : { reason: input.cancellation.reason }),
            ...(input.cancellation.deadlineAt === undefined ? {} : { deadlineAt: input.cancellation.deadlineAt }),
            at
          }),
          input.lineage
        ))
        return [{
          type: "CancellationDispatched",
          request: input.request,
          invocation: input.child,
          target: input.target,
          timeoutMs,
          deadlineAt,
          at
        } satisfies CancellationDispatched]
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
  (child, request) => {
    if (callSettled(events, child)) return "done"
    const answered = events.some((event) =>
      (event.type === "ResponseReceived" || event.type === "CallTimedOut") &&
      String((event as { readonly method?: unknown }).method) === CANCELLATION_CONTROL_METHOD &&
      String((event as { readonly call?: unknown }).call) === request
    )
    if (answered) return "done"
    return events.some((event) =>
      event.type === "CancellationDispatched" &&
      String((event as { readonly request?: unknown }).request) === request
    ) ? "dispatched" : "ready"
  }
)

interface ProjectedCancellationRecord {
  readonly cancellation: InvocationCancellation
  readonly accepted: ActorMethodCancellationState | undefined
}

interface ProjectedChildLink extends ChildCancellationLink {
  readonly parent: ActorInvocation
}

interface ActorCancellationProjectionState {
  readonly methods: ReadonlyMap<string, unknown>
  readonly components: ReadonlyArray<unknown>
  readonly requests: ReadonlyArray<ProjectedCancellationRecord>
  readonly links: ReadonlyArray<ProjectedChildLink>
  readonly settledCalls: ReadonlySet<string>
  readonly answeredCancellations: ReadonlySet<string>
  readonly dispatchedCancellations: ReadonlySet<string>
  readonly recorded: ReadonlySet<string>
}

const callKeyOf = (method: string, call: string): string => JSON.stringify([method, call])

const projectedChildCancellationTransitionsOf = <R>(
  state: ActorCancellationProjectionState,
  cancellation: InvocationCancellation,
  timeoutMs: number
): ReadonlyArray<Transition<never, R | Router | Self>> => childCancellationTransitions<R>(
  state.links.filter((link) => sameInvocation(link.parent, cancellation.invocation)),
  cancellation,
  timeoutMs,
  (child, request) =>
    state.settledCalls.has(callKeyOf(child.method, child.id)) || state.answeredCancellations.has(request)
      ? "done"
      : state.dispatchedCancellations.has(request) ? "dispatched" : "ready"
)

// actorCancellationProjection constructs the control-plane quotient when every cancellation observer is incremental.
export const actorCancellationProjection = <R>(
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS
): ActorControlProjection<R | Router | Self> | undefined => {
  const entries = Object.entries(methods)
  const supported = entries.every(([, method]) =>
    method.incremental !== undefined &&
    (method.cancellation === undefined || method.incremental.cancellation !== undefined)
  )
  if (!supported) return undefined
  const timeoutMs = childCancellationTimeoutOf(childTimeoutMs)
  const initial = (): ActorCancellationProjectionState => ({
    methods: initialMethodStates(methods),
    components: components.map((component) => component.machine.initial()),
    requests: [],
    links: [],
    settledCalls: new Set(),
    answeredCancellations: new Set(),
    dispatchedCancellations: new Set(),
    recorded: new Set()
  })
  const reduce = (state: ActorCancellationProjectionState, event: Event): ActorCancellationProjectionState => {
    const request = cancellationRequestedOf(event)
    const requests = request === undefined
      ? state.requests
      : [...state.requests, {
          cancellation: request,
          accepted: methods[request.invocation.method]?.incremental?.cancellation?.(
            state.methods.get(request.invocation.method),
            request.invocation
          )
        }]
    const methodsState = reduceMethodStates(methods, state.methods, event)
    const componentsState = components.map((component, index) =>
      component.machine.step(state.components[index], event)
    )
    const links = [...state.links]
    if (event.type === "InvocationLinked") {
      const link = event as {
        readonly parent?: ActorInvocation
        readonly child?: { readonly invocation?: ActorInvocation }
        readonly target?: unknown
        readonly lineage?: ThreadLineage
      }
      if (link.parent !== undefined && link.child?.invocation !== undefined && typeof link.target === "string") {
        links.push({
          parent: link.parent,
          child: link.child.invocation,
          target: link.target,
          ...(link.lineage === undefined ? {} : { lineage: link.lineage })
        })
      }
    }
    const settledCalls = new Set(state.settledCalls)
    const answeredCancellations = new Set(state.answeredCancellations)
    if (event.type === "ResponseReceived" || event.type === "CallTimedOut") {
      const method = String((event as { readonly method?: unknown }).method)
      const call = String((event as { readonly call?: unknown }).call)
      settledCalls.add(callKeyOf(method, call))
      if (method === CANCELLATION_CONTROL_METHOD) answeredCancellations.add(call)
    }
    const dispatchedCancellations = new Set(state.dispatchedCancellations)
    if (event.type === "CancellationDispatched") {
      dispatchedCancellations.add(String((event as { readonly request?: unknown }).request))
    }
    const recorded = new Set(state.recorded)
    const key = keyOf(event)
    if (key !== undefined) recorded.add(key)
    return {
      methods: methodsState,
      components: componentsState,
      requests,
      links,
      settledCalls,
      answeredCancellations,
      dispatchedCancellations,
      recorded
    }
  }
  const cancellationOf = (state: ActorCancellationProjectionState, invocation: ActorInvocation) =>
    methods[invocation.method]?.incremental?.cancellation?.(state.methods.get(invocation.method), invocation)
  const pending = (state: ActorCancellationProjectionState): ReadonlyArray<InvocationCancellation> => {
    const seen = new Set<string>()
    const result: Array<InvocationCancellation> = []
    for (const record of state.requests) {
      const invocation = record.cancellation.invocation
      const current = cancellationOf(state, invocation)
      if (current !== "running" || (record.accepted !== undefined && record.accepted !== "running")) continue
      const key = invocationKeyOf(invocation)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(record.cancellation)
    }
    return result
  }
  return {
    initial,
    reduce: (state, event) => reduce(state as ActorCancellationProjectionState, event),
    cancellationOf: (state, invocation) => cancellationOf(state as ActorCancellationProjectionState, invocation),
    suppresses: (state, invocation) => (state as ActorCancellationProjectionState).requests.some((record) =>
      sameInvocation(record.cancellation.invocation, invocation) &&
      (record.accepted === "running" || cancellationOf(state as ActorCancellationProjectionState, invocation) === "running")
    ),
    residuals: (erased) => {
      const state = erased as ActorCancellationProjectionState
      const cancellations = pending(state)
      if (cancellations.length === 0) return undefined
      const terminals: Array<Transition<never, R | Router | Self>> = []
      const obligations: Array<Transition<never, R | Router | Self>> = []
      for (const cancellation of cancellations) {
        const child = projectedChildCancellationTransitionsOf<R>(state, cancellation, timeoutMs)
        const component = components.flatMap((entry, index) =>
          entry.machine.cancel?.(state.components[index], cancellation) ?? []
        )
        const outstanding = [...child, ...component].filter((transition) => !state.recorded.has(transition.key))
        if (outstanding.length === 0) terminals.push(terminalTransitionOf(cancellation, methods, keyOf))
        else obligations.push(...outstanding)
      }
      return [...terminals, ...obligations]
    }
  }
}

// cancellationTransitionsOf projects independent component cleanup and method terminals for pending invocations.
export const cancellationTransitionsOf = <R>(
  events: ReadonlyArray<Event>,
  methods: ActorMethods,
  components: ReadonlyArray<Component<unknown, R>>,
  keyOf: (event: Event) => string | undefined,
  childTimeoutMs = DEFAULT_CHILD_CANCELLATION_TIMEOUT_MS
): ReadonlyArray<Transition<never, R | Router | Self>> | undefined => {
  const timeoutMs = childCancellationTimeoutOf(childTimeoutMs)
  const cancellations = pendingCancellationsOf(events, methods)
  if (cancellations.length === 0) return undefined
  const recorded = new Set(events.flatMap((event) => {
    const key = keyOf(event)
    return key === undefined ? [] : [key]
  }))
  const terminals: Array<Transition<never, R | Router | Self>> = []
  const obligations: Array<Transition<never, R | Router | Self>> = []
  for (const cancellation of cancellations) {
    const pending = [
      ...childCancellationTransitionsOf<R>(events, cancellation, timeoutMs),
      ...components.flatMap((component) => cancelComponent(component, events, cancellation))
    ]
      .filter((transition) => !recorded.has(transition.key))
    if (pending.length === 0) {
      terminals.push(terminalTransitionOf(cancellation, methods, keyOf))
    } else {
      obligations.push(...pending)
    }
  }
  return [...terminals, ...obligations]
}

// cancellationMethodFor constructs the internal control method paired with an actor's cancellable methods.
interface CancellationMethodState {
  readonly methods: ReadonlyMap<string, unknown>
  readonly requests: ReadonlyMap<string, {
    readonly cancellation: InvocationCancellation
    readonly accepted: ActorMethodCancellationState | undefined
  }>
}

const cancellationMethodState = (
  target: ActorInvocation,
  cancellable: boolean,
  accepted: ActorMethodCancellationState | undefined,
  current: ActorMethodCancellationState | undefined
) => {
  if (!cancellable) return { status: "failed" as const, error: `method ${JSON.stringify(target.method)} is not cancellable` }
  if (accepted === undefined) return { status: "failed" as const, error: `invocation ${JSON.stringify(target.id)} does not exist` }
  if (accepted === "terminal") return { status: "completed" as const, output: { cancelled: false } }
  if (accepted === "cancelled") return { status: "completed" as const, output: { cancelled: true } }
  if (current === "running") return { status: "pending" as const }
  return { status: "completed" as const, output: { cancelled: current === "cancelled" } }
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
  ...(Object.values(methods).every((method) => method.incremental !== undefined)
    ? {
        incremental: {
          initial: (): CancellationMethodState => ({
            methods: initialMethodStates(methods),
            requests: new Map()
          }),
          reduce: (state: CancellationMethodState, event: Event): CancellationMethodState => {
            const requests = new Map(state.requests)
            const request = cancellationRequestedOf(event)
            if (request !== undefined && !requests.has(request.request)) {
              const method = methods[request.invocation.method]
              const projected = state.methods.get(request.invocation.method)
              requests.set(request.request, {
                cancellation: request,
                accepted: method?.incremental?.cancellation?.(projected, request.invocation)
              })
            }
            const projected = reduceMethodStates(methods, state.methods, event)
            return { methods: projected, requests }
          },
          currentEpoch: () => 0,
          state: (state: CancellationMethodState, invocation: ActorInvocation) => {
            const record = state.requests.get(invocation.id)
            if (record === undefined) return undefined
            const target = record.cancellation.invocation
            const method = methods[target.method]
            const cancellation = method?.incremental?.cancellation
            return cancellationMethodState(
              target,
              method?.cancellation !== undefined && cancellation !== undefined,
              record.accepted,
              cancellation?.(state.methods.get(target.method), target)
            )
          }
        }
      }
    : {}),
  state: (events, invocation) => {
    const id = invocation.id
    const requestAt = events.findIndex((event) => cancellationRequestedOf(event)?.request === id)
    if (requestAt < 0) return undefined
    const request = cancellationRequestedOf(events[requestAt]!)!
    const cancellation = methods[request.invocation.method]?.cancellation
    return cancellationMethodState(
      request.invocation,
      cancellation !== undefined,
      cancellation?.state(events.slice(0, requestAt), request.invocation),
      cancellation?.state(events, request.invocation)
    )
  }
})
