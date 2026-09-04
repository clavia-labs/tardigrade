import type { Event } from "@clavia/tardigrade-core/event"
import { intent } from "@clavia/tardigrade-core/intent"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import type { CompleteTransitionDerivation } from "@clavia/tardigrade-core/transition"
import type { KeyFragment } from "../log"
import { component, type Component } from "@clavia/tardigrade-core/component"
import {
  CANCELLATION_CONTROL_METHOD,
  cancellationRequested,
  cancellationRequestedOf,
  type CancellationDispatched
} from "./cancellation"
import type { ActorInvocation, ActorInvocationContext } from "./call"
import { cancellationStateOf, initialMethodStates, reduceMethodStates, type ActorMethods } from "./method"
import type { ActorMethodView } from "./view"

// AlarmFired records the platform alarm crossing in an actor's private log.
export interface AlarmFired extends Event {
  readonly type: "AlarmFired"
  readonly scheduledFor: number
  readonly at: number
}

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

// CallTimedOut is the caller terminal produced when an alarm crosses a recorded deadline.
export interface CallTimedOut extends Event {
  readonly type: "CallTimedOut"
  readonly call: string
  readonly method: string
  readonly target: string
  readonly timeoutMs: number
  readonly deadlineAt: number
  readonly at: number
}

export const methodTimeoutKeys: KeyFragment = {
  prefixes: ["malarm:", "mterm:"],
  keyOf: (event) => {
    if (event.type === "AlarmFired") {
      return `malarm:${String((event as { readonly scheduledFor?: unknown }).scheduledFor)}`
    }
    if (event.type === "ResponseReceived" || event.type === "CallTimedOut") {
      return `mterm:${String((event as { readonly call?: unknown }).call)}`
    }
    return undefined
  }
}

interface Dispatch {
  readonly call: string
  readonly method: string
  readonly target: string
  readonly timeoutMs: number
  readonly deadlineAt: number
}

const terminalCalls = (log: ReadonlyArray<Event>): ReadonlySet<string> => new Set(log.flatMap((event) => {
  if (event.type !== "ResponseReceived" && event.type !== "CallTimedOut") return []
  const call = (event as { readonly call?: unknown }).call
  return typeof call === "string" ? [call] : []
}))

const dispatchesOf = (log: ReadonlyArray<Event>): ReadonlyArray<Dispatch> => log.flatMap((event) => {
  if (event.type === "CancellationDispatched") {
    const cancellation = event as CancellationDispatched
    if (!Number.isSafeInteger(cancellation.timeoutMs) || cancellation.timeoutMs < 1 ||
      !Number.isSafeInteger(cancellation.deadlineAt)) return []
    return [{
      call: cancellation.request,
      method: CANCELLATION_CONTROL_METHOD,
      target: cancellation.target,
      timeoutMs: cancellation.timeoutMs,
      deadlineAt: cancellation.deadlineAt
    }]
  }
  if (event.type !== "CallDispatched") return []
  const candidate = event as {
    readonly id?: unknown
    readonly method?: unknown
    readonly target?: unknown
    readonly timeoutMs?: unknown
    readonly deadlineAt?: unknown
  }
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.method !== "string" ||
    typeof candidate.target !== "string" ||
    typeof candidate.timeoutMs !== "number" ||
    !Number.isSafeInteger(candidate.deadlineAt)
  ) return []
  return [{
    call: candidate.id,
    method: candidate.method,
    target: candidate.target,
    timeoutMs: candidate.timeoutMs,
    deadlineAt: candidate.deadlineAt as number
  }]
})

export interface InvocationDeadline {
  readonly invocation: ActorInvocation
  readonly deadlineAt: number
}

const invocationDeadlinesOf = (log: ReadonlyArray<Event>): ReadonlyArray<InvocationDeadline> => {
  const seen = new Set<string>()
  return log.flatMap((event) => {
    const context = (event as { readonly call?: unknown }).call as Partial<ActorInvocationContext> | undefined
    if (context === undefined || context.invocation === undefined || typeof context.deadlineAt !== "number") return []
    const invocation = context.invocation
    const key = JSON.stringify([invocation.method, invocation.id, invocation.epoch])
    if (seen.has(key)) return []
    seen.add(key)
    return [{ invocation, deadlineAt: context.deadlineAt }]
  })
}

const deadlineAlreadyCrossed = (log: ReadonlyArray<Event>, deadlineAt: number): boolean =>
  log.some((event) => event.type === "AlarmFired" && typeof event.at === "number" && event.at >= deadlineAt)

const invocationSettled = (
  log: ReadonlyArray<Event>,
  invocation: ActorInvocation,
  methods?: ActorMethods
): boolean => {
  if (log.some((event) =>
    cancellationRequestedOf(event)?.invocation.method === invocation.method &&
      cancellationRequestedOf(event)?.invocation.id === invocation.id &&
      cancellationRequestedOf(event)?.invocation.epoch === invocation.epoch ||
    event.type === "ResponseDelivered" &&
      String((event as { readonly method?: unknown }).method) === invocation.method &&
      String((event as { readonly call?: unknown }).call) === invocation.id
  )) return true
  const state = methods?.[invocation.method]?.state(log, invocation)
  return state !== undefined && state.status !== "pending"
}

// earliestDeadlineOf projects the next physical wake from unresolved durable method calls.
export const earliestDeadlineOf = (log: ReadonlyArray<Event>, methods?: ActorMethods): number | undefined => {
  const terminal = terminalCalls(log)
  let earliest: number | undefined
  for (const dispatch of dispatchesOf(log)) {
    if (terminal.has(dispatch.call)) continue
    earliest = earliest === undefined ? dispatch.deadlineAt : Math.min(earliest, dispatch.deadlineAt)
  }
  for (const deadline of invocationDeadlinesOf(log)) {
    if (invocationSettled(log, deadline.invocation, methods) || deadlineAlreadyCrossed(log, deadline.deadlineAt)) continue
    earliest = earliest === undefined ? deadline.deadlineAt : Math.min(earliest, deadline.deadlineAt)
  }
  return earliest
}

const invocationKey = (invocation: ActorInvocation): string =>
  JSON.stringify([invocation.method, invocation.id, invocation.epoch])

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

const timeoutTransition = (dispatch: Dispatch, at: number) => intent({
  key: `mterm:${dispatch.call}`,
  input: { dispatch, at },
  events: ({ dispatch: current, at: firedAt }) => [{
    type: "CallTimedOut",
    call: current.call,
    method: current.method,
    target: current.target,
    timeoutMs: current.timeoutMs,
    deadlineAt: current.deadlineAt,
    at: firedAt
  } satisfies CallTimedOut]
})

const deadlineCancellationTransition = (invocation: ActorInvocation, deadlineAt: number) => intent({
  key: `cx:${invocationKey(invocation)}`,
  input: {
    request: `deadline/${invocation.method}/${invocation.id}/${invocation.epoch}/${deadlineAt}`,
    invocation,
    deadlineAt
  },
  events: (current, at) => [cancellationRequested({
    request: current.request,
    invocation: current.invocation,
    cause: "deadline",
    deadlineAt: current.deadlineAt,
    at
  })]
})

// deadlineCancellationsAt projects the invocation deadlines an observed time has crossed into the same cancellation targets the caller path uses.
export const deadlineCancellationsAt = (
  log: ReadonlyArray<Event>,
  methods: ActorMethods,
  at: number
): ReadonlyArray<InvocationDeadline> => {
  const views = new Map<string, ActorMethodView<unknown>>()
  return invocationDeadlinesOf(log).flatMap(({ invocation, deadlineAt }) => {
    if (deadlineAt > at) return []
    const method = methods[invocation.method]
    if (method === undefined || method.cancellation === undefined || invocationSettled(log, invocation)) return []
    let view = views.get(invocation.method)
    if (view === undefined) {
      view = replayProjection(method.projection, log)
      views.set(invocation.method, view)
    }
    return cancellationStateOf(method, view, invocation) !== "running" ? [] : [{ invocation, deadlineAt }]
  })
}

// deadlineCancellationEventsAt constructs the durable cancellation requests one observed crossing commits alongside its alarm fact.
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
export const methodTimeoutDerivation: CompleteTransitionDerivation = (log) => {
  const terminal = terminalCalls(log)
  const alarms = alarmsOf(log)
  return dispatchesOf(log).flatMap((dispatch) => {
    if (terminal.has(dispatch.call)) return []
    const alarm = alarmFor(alarms, dispatch.deadlineAt)
    return alarm === undefined ? [] : [timeoutTransition(dispatch, alarm.at)]
  })
}

// methodDeadlineCancellationDerivation projects the deadline cancellations a recorded alarm crossed, for logs written before the alarm handler committed them (timeout.test.ts, "a crossed deadline projects its cancellation before and after commit").
export const methodDeadlineCancellationDerivation = (methods: ActorMethods): CompleteTransitionDerivation => (log) =>
  alarmsOf(log).flatMap((alarm) =>
    deadlineCancellationsAt(log, methods, alarm.at).map(({ invocation, deadlineAt }) =>
      deadlineCancellationTransition(invocation, deadlineAt)
    )
  )

/** @deprecated Use methodTimeoutDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodTimeoutReactor: CompleteTransitionDerivation = (log) => methodTimeoutDerivation(log)

/** @deprecated Use methodDeadlineCancellationDerivation. This compatibility name describes a complete-history transition derivation. */
export const methodDeadlineCancellationReactor = (methods: ActorMethods): CompleteTransitionDerivation =>
  methodDeadlineCancellationDerivation(methods)

export interface MethodTimeoutProjectionState {
  readonly dispatches: ReadonlyMap<string, Dispatch>
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
    if (!dispatches.has(dispatch.call)) dispatches.set(dispatch.call, dispatch)
  }
  const terminalCalls = new Set(state.terminalCalls)
  if (event.type === "ResponseReceived" || event.type === "CallTimedOut") {
    terminalCalls.add(String((event as { readonly call?: unknown }).call ?? ""))
  }
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
      if (deadline.invocation.method === method && deadline.invocation.id === id) {
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
): ReadonlyArray<ReturnType<typeof intent>> => {
  const transitions = [] as Array<ReturnType<typeof intent>>
  for (const dispatch of state.dispatches.values()) {
    if (state.terminalCalls.has(dispatch.call)) continue
    const alarm = alarmFor(state.alarms, dispatch.deadlineAt)
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
    transitions.push(deadlineCancellationTransition(invocation, deadline.deadlineAt))
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
    name: "actor.method-timeouts",
    keys: methodTimeoutKeys,
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
