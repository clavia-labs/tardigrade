import { type AlarmFired, type CallTimedOut } from "./events"
import { eventAt, eventPositionOf, type Event } from "@clavia/tardigrade-core/event"
import { bindTransitionContext } from "../transition/transition"
import type { Intent } from "@clavia/tardigrade-core/intent"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log/index"
import { component, type Component } from "@clavia/tardigrade-core/component"
import { cancellationRequested, cancellationRequestedOf } from "./cancellation"
import { type ActorInvocationContext, invocationKey, sameInvocation, type InvocationRef, invocationCoordinateKey } from "./invocation"

import { recordedDispatchOf, terminalInvocationRefOf, terminalStorageKey, type RecordedDispatch } from "./records-compat"

import { cancellationStateOf, initialMethodStates, reduceMethodStates, type ActorMethodView } from "./state"
import { type ActorMethods } from "../actor/method"

export interface AlarmFiredFields {
  readonly scheduledFor: number
  readonly at: number
}

export const alarmFired = (fields: AlarmFiredFields): AlarmFired => {
  if (!Number.isSafeInteger(fields.scheduledFor) || fields.scheduledFor < 0) {
    throw new Error("alarm scheduledFor must be a non-negative safe integer")
  }
  if (!Number.isSafeInteger(fields.at) || fields.at < fields.scheduledFor) {
    throw new Error("alarm at must be a safe integer at or after scheduledFor")
  }
  return { type: "AlarmFired", ...fields }
}

export const methodTimeoutKeys: KeyFragment = {
  prefixes: ["malarm:", "mterm:"],
  keyOf: (event) => {
    if (event.type === "AlarmFired") {
      return `malarm:${String((event as { readonly scheduledFor?: unknown }).scheduledFor)}`
    }
    if (event.type === "ResponseReceived" || event.type === "CallTimedOut") {
      const terminal = event as CallTimedOut
      return terminalStorageKey(terminal)
    }
    return undefined
  }
}

const terminalCalls = (log: ReadonlyArray<Event>): ReadonlySet<string> => new Set(log.flatMap((event) => {
  const reference = terminalInvocationRefOf(event)
  return reference === undefined ? [] : [invocationCoordinateKey(reference)]
}))

interface OwnedDispatch extends RecordedDispatch { readonly owner: Event }

const dispatchesOf = (log: ReadonlyArray<Event>): ReadonlyArray<OwnedDispatch> => log.flatMap((event) => {
  const dispatch = recordedDispatchOf(event)
  return dispatch === undefined ? [] : [{ ...dispatch, owner: event }]
})

interface InvocationDeadline {
  readonly owner: Event
  readonly invocation: InvocationRef
  readonly deadlineAt: number
}

const invocationDeadlinesOf = (log: ReadonlyArray<Event>): ReadonlyArray<InvocationDeadline> => {
  const seen = new Set<string>()
  return log.flatMap((event) => {
    const context = (event as { readonly call?: unknown }).call as Partial<ActorInvocationContext> | undefined
    if (context === undefined || context.invocation === undefined || typeof context.deadlineAt !== "number") return []
    const invocation = context.invocation
    const key = invocationKey(invocation)
    if (seen.has(key)) return []
    seen.add(key)
    return [{ owner: event, invocation, deadlineAt: context.deadlineAt }]
  })
}

const deadlineAlreadyCrossed = (log: ReadonlyArray<Event>, deadlineAt: number): boolean =>
  log.some((event) => event.type === "AlarmFired" && typeof event.at === "number" && event.at >= deadlineAt)

const invocationSettled = (
  log: ReadonlyArray<Event>,
  invocation: InvocationRef,
  methods?: ActorMethods
): boolean => {
  if (log.some((event) => {
    const cancelled = cancellationRequestedOf(event)?.invocation
    if (cancelled !== undefined && sameInvocation(cancelled, invocation)) return true
    return event.type === "ResponseDelivered" && sameInvocation({
      method: String(event.method), id: String(event.call), epoch: (event.epoch as number | undefined) ?? 0
    }, invocation)
  })) return true
  const state = methods?.[invocation.method]?.state(log, invocation)
  return state !== undefined && state.status !== "pending"
}

// earliestDeadlineOf projects the next physical wake from unresolved durable method calls.
export const earliestDeadlineOf = (log: ReadonlyArray<Event>, methods?: ActorMethods): number | undefined => {
  const terminal = terminalCalls(log)
  let earliest: number | undefined
  for (const dispatch of dispatchesOf(log)) {
    if (terminal.has(invocationCoordinateKey(dispatch.reference))) continue
    earliest = earliest === undefined ? dispatch.terminal.deadlineAt : Math.min(earliest, dispatch.terminal.deadlineAt)
  }
  for (const deadline of invocationDeadlinesOf(log)) {
    if (invocationSettled(log, deadline.invocation, methods) || deadlineAlreadyCrossed(log, deadline.deadlineAt)) continue
    earliest = earliest === undefined ? deadline.deadlineAt : Math.min(earliest, deadline.deadlineAt)
  }
  return earliest
}

const alarmsOf = (events: ReadonlyArray<Event>): ReadonlyArray<AlarmFired> => events.flatMap((event) =>
  event.type === "AlarmFired" && typeof event.at === "number" ? [event as AlarmFired] : [])

const alarmFor = (alarms: ReadonlyArray<AlarmFired>, deadlineAt: number): AlarmFired | undefined => {
  let earliest: AlarmFired | undefined
  for (const alarm of alarms) {
    if (alarm.at < deadlineAt || (earliest !== undefined && alarm.at >= earliest.at)) continue
    earliest = alarm
  }
  return earliest
}

const timeoutTransition = (dispatch: OwnedDispatch, at: number) =>
  bindTransitionContext(dispatch.owner, "actor.deadlines").intent("timeout", {
    type: "CallTimedOut", ...dispatch.terminal, at
  } satisfies CallTimedOut, { invocation: null })

const deadlineCancellationTransition = ({ owner, invocation, deadlineAt }: InvocationDeadline) =>
  bindTransitionContext(owner, "actor.deadlines").intent("cancel", (at) => cancellationRequested({
    request: `deadline/${invocation.method}/${invocation.id}/${invocation.epoch}/${deadlineAt}`,
    invocation, cause: "deadline", deadlineAt, at
  }), { invocation: null })

// deadlineCancellationsAt selects crossed deadlines for running cancellable invocations (timeout.test.ts, "cancellation selection projects one cancellation from an eligible invocation").
const deadlineCancellationsAt = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods,
  at: number
): ReadonlyArray<InvocationDeadline> => {
  const views = new Map<string, ActorMethodView<unknown>>()
  return invocationDeadlinesOf(log).flatMap(({ owner, invocation, deadlineAt }) => {
    if (deadlineAt > at) return []
    const method = methods[invocation.method]
    if (method === undefined || method.cancellation === undefined || invocationSettled(log, invocation)) return []
    let view = views.get(invocation.method)
    if (view === undefined) {
      view = replayProjection(method.projection, log)
      views.set(invocation.method, view)
    }
    return cancellationStateOf(method, view, invocation) !== "running" ? [] : [{ owner, invocation, deadlineAt }]
  })
}

// deadlineCancellationEventsAt constructs durable requests for selected deadline cancellations (test/actor.workers.ts, "an alarm commits its deadline cancellation atomically").
export const deadlineCancellationEventsAt = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods,
  at: number
): ReadonlyArray<Event> =>
  deadlineCancellationsAt(log, methods, at).map(({ invocation, deadlineAt }) =>
    cancellationRequested({
      request: `deadline/${invocation.method}/${invocation.id}/${invocation.epoch}/${deadlineAt}`,
      invocation,
      cause: "deadline",
      deadlineAt,
      at
    })
  )

// methodTimeoutDerivation turns alarm facts into method terminals without reading a clock.
export const methodTimeoutDerivation: CompleteTransitionDerivation = (events) => {
  const log = events.map((event, index) => eventAt(event, eventPositionOf(event) ?? index + 1))
  const terminal = terminalCalls(log)
  const alarms = alarmsOf(log)
  return dispatchesOf(log).flatMap((dispatch) => {
    if (terminal.has(invocationCoordinateKey(dispatch.reference))) return []
    const alarm = alarmFor(alarms, dispatch.terminal.deadlineAt)
    return alarm === undefined ? [] : [timeoutTransition(dispatch, alarm.at)]
  })
}

// methodDeadlineCancellationDerivation repairs missing cancellations from recorded alarms (timeout.test.ts, "legacy recovery derives an alarm's missing cancellation exactly once").
export const methodDeadlineCancellationDerivation = (methods: ActorMethods): CompleteTransitionDerivation => (events) => {
  const log = events.map((event, index) => eventAt(event, eventPositionOf(event) ?? index + 1))
  const latestAlarmAt = alarmsOf(log).reduce<number | undefined>(
    (latest, alarm) => latest === undefined ? alarm.at : Math.max(latest, alarm.at),
    undefined
  )
  if (latestAlarmAt === undefined) return []
  return deadlineCancellationsAt(log, methods, latestAlarmAt)
    .map(deadlineCancellationTransition)
}

/** @deprecated Use methodTimeoutDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodTimeoutReactor: CompleteTransitionDerivation = (log) => methodTimeoutDerivation(log)

/** @deprecated Use methodDeadlineCancellationDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodDeadlineCancellationReactor = (methods: ActorMethods): CompleteTransitionDerivation =>
  methodDeadlineCancellationDerivation(methods)

export interface MethodTimeoutProjectionState {
  readonly dispatches: ReadonlyMap<string, OwnedDispatch>
  readonly terminalCalls: ReadonlySet<string>
  readonly alarms: ReadonlyArray<AlarmFired>
  readonly deadlines: ReadonlyMap<string, InvocationDeadline>
  readonly settledInvocations: ReadonlySet<string>
}

// initialMethodTimeoutState constructs method deadline bookkeeping.
export const initialMethodTimeoutState = (): MethodTimeoutProjectionState => ({
  dispatches: new Map(),
  terminalCalls: new Set(),
  alarms: [],
  deadlines: new Map(),
  settledInvocations: new Set()
})

// reduceMethodTimeoutState advances method deadline bookkeeping with one event.
export const reduceMethodTimeoutState = (
  state: MethodTimeoutProjectionState,
  event: Event
): MethodTimeoutProjectionState => {
  const dispatches = new Map(state.dispatches)
  for (const dispatch of dispatchesOf([event])) {
    const key = invocationCoordinateKey(dispatch.reference)
    if (!dispatches.has(key)) dispatches.set(key, dispatch)
  }
  const terminalCalls = new Set(state.terminalCalls)
  const terminal = terminalInvocationRefOf(event)
  if (terminal !== undefined) terminalCalls.add(invocationCoordinateKey(terminal))
  const deadlines = new Map(state.deadlines)
  for (const deadline of invocationDeadlinesOf([event])) {
    const key = invocationKey(deadline.invocation)
    if (!deadlines.has(key)) deadlines.set(key, deadline)
  }
  const settledInvocations = new Set(state.settledInvocations)
  const cancellation = cancellationRequestedOf(event)
  if (cancellation !== undefined) settledInvocations.add(invocationKey(cancellation.invocation))
  if (event.type === "ResponseDelivered") {
    const method = String((event as { readonly method?: unknown }).method ?? "")
    const id = String((event as { readonly call?: unknown }).call ?? "")
    for (const deadline of deadlines.values()) {
      if (sameInvocation(deadline.invocation, { method, id, epoch: (event.epoch as number | undefined) ?? 0 })) {
        settledInvocations.add(invocationKey(deadline.invocation))
      }
    }
  }
  return {
    dispatches,
    terminalCalls,
    alarms: event.type === "AlarmFired" ? [...state.alarms, event as AlarmFired] : state.alarms,
    deadlines,
    settledInvocations
  }
}

// methodTimeoutTransitions derives caller timeouts and invocation deadline cancellations.
export const methodTimeoutTransitions = (
  methods: ActorMethods,
  methodStates: ReadonlyMap<string, unknown>,
  state: MethodTimeoutProjectionState
): ReadonlyArray<Intent<never>> => {
  const transitions = [] as Array<Intent<never>>
  for (const dispatch of state.dispatches.values()) {
    if (state.terminalCalls.has(invocationCoordinateKey(dispatch.reference))) continue
    const alarm = alarmFor(state.alarms, dispatch.terminal.deadlineAt)
    if (alarm !== undefined) transitions.push(timeoutTransition(dispatch, alarm.at))
  }
  for (const deadline of state.deadlines.values()) {
    const invocation = deadline.invocation
    const method = methods[invocation.method]
    if (method?.cancellation === undefined) continue
    const view = method.projection.output(methodStates.get(invocation.method))
    const current = view.invocationState(invocation)
    if (state.settledInvocations.has(invocationKey(invocation)) || current?.status !== "pending") continue
    const alarm = alarmFor(state.alarms, deadline.deadlineAt)
    if (alarm === undefined || cancellationStateOf(method, view, invocation) !== "running") continue
    transitions.push(deadlineCancellationTransition(deadline))
  }
  return transitions
}

// methodTimeoutComponent mounts durable method deadlines on every actor.
export const methodTimeoutComponent = (methods: ActorMethods): Component<undefined> => {
  interface State {
    readonly methods: ReadonlyMap<string, unknown>
    readonly timeout: MethodTimeoutProjectionState
  }
  return component<State, undefined>({
    name: "actor.deadlines",
    initial: () => ({
      methods: initialMethodStates(methods),
      timeout: initialMethodTimeoutState()
    }),
    step: (state, event) => ({
      methods: reduceMethodStates(methods, state.methods, event),
      timeout: reduceMethodTimeoutState(state.timeout, event)
    }),
    output: (state) => ({ view: undefined, transitions: methodTimeoutTransitions(methods, state.methods, state.timeout) })
  })
}
