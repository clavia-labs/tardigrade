import { Clock, Effect, Schema } from "effect"
import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log/keys"
import { methodEnvelopeOf } from "../../communication/envelope"
import { parseThreadAddress } from "../../communication/endpoint"
import { linkOf } from "../../communication/link"
import { Router } from "../../communication/router"
import { effect, intent, Self, type Transition } from "../../reconciliation"
import type { ThreadLineage } from "../../thread"
import type { Component } from "../component"
import { ActorInvocationSchema, type ActorInvocation } from "./call"
import { actorMethod, type ActorMethodDeclaration, type ActorMethods } from "./definition"

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

const childLinksOf = (
  events: ReadonlyArray<Event>,
  parent: ActorInvocation
): ReadonlyArray<{
  readonly child: ActorInvocation
  readonly target: string
  readonly lineage?: ThreadLineage
}> => events.flatMap((event) => {
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

const childCancellationTransitionsOf = <R>(
  events: ReadonlyArray<Event>,
  cancellation: InvocationCancellation,
  timeoutMs: number
): ReadonlyArray<Transition<never, R | Router | Self>> => childLinksOf(events, cancellation.invocation)
  .flatMap(({ child, target, lineage }) => {
    if (callSettled(events, child)) return []
    const request = `cancel/${cancellation.request}/${child.method}/${child.id}/${child.epoch}`
    const answered = events.some((event) =>
      (event.type === "ResponseReceived" || event.type === "CallTimedOut") &&
      String((event as { readonly method?: unknown }).method) === CANCELLATION_CONTROL_METHOD &&
      String((event as { readonly call?: unknown }).call) === request
    )
    if (answered) return []
    const dispatched = events.some((event) =>
      event.type === "CancellationDispatched" &&
      String((event as { readonly request?: unknown }).request) === request
    )
    if (dispatched) {
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
      ...components
      .flatMap((component) => component.cancel?.(events, cancellation) ?? [])
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
  state: (events, invocation) => {
    const id = invocation.id
    const requestAt = events.findIndex((event) => cancellationRequestedOf(event)?.request === id)
    if (requestAt < 0) return undefined
    const request = cancellationRequestedOf(events[requestAt]!)!
    const cancellation = methods[request.invocation.method]?.cancellation
    if (cancellation === undefined) {
      return { status: "failed" as const, error: `method ${JSON.stringify(request.invocation.method)} is not cancellable` }
    }
    const accepted = cancellation.state(events.slice(0, requestAt), request.invocation)
    if (accepted === undefined) {
      return { status: "failed" as const, error: `invocation ${JSON.stringify(request.invocation.id)} does not exist` }
    }
    if (accepted === "terminal") return { status: "completed" as const, output: { cancelled: false } }
    if (accepted === "cancelled") return { status: "completed" as const, output: { cancelled: true } }
    const current = cancellation.state(events, request.invocation)
    if (current === "running") return { status: "pending" as const }
    return { status: "completed" as const, output: { cancelled: current === "cancelled" } }
  }
})
