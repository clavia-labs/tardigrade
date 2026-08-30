import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log"
import { intent, type Reactor } from "../../reconciliation"
import type { Component } from "../component"
import {
  CANCELLATION_CONTROL_METHOD,
  cancellationRequested,
  cancellationRequestedOf,
  type CancellationDispatched
} from "./cancellation"
import type { ActorInvocation, ActorInvocationContext } from "./call"
import type { ActorMethods } from "./definition"

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

interface InvocationDeadline {
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

const firingFor = (log: ReadonlyArray<Event>, dispatch: Dispatch): AlarmFired | undefined =>
  log.reduce<AlarmFired | undefined>((earliest, event) => {
    if (event.type !== "AlarmFired" || typeof event.at !== "number" || event.at < dispatch.deadlineAt) {
      return earliest
    }
    return earliest === undefined || event.at < earliest.at ? event as AlarmFired : earliest
  }, undefined)

// methodTimeoutReactor turns alarm facts into method terminals without reading a clock.
export const methodTimeoutReactor: Reactor = (log) => {
  const terminal = terminalCalls(log)
  return dispatchesOf(log).flatMap((dispatch) => {
    if (terminal.has(dispatch.call)) return []
    const alarm = firingFor(log, dispatch)
    if (alarm === undefined) return []
    return [intent({
      key: `mterm:${dispatch.call}`,
      input: { dispatch, at: alarm.at },
      events: ({ dispatch: current, at }) => [{
        type: "CallTimedOut",
        call: current.call,
        method: current.method,
        target: current.target,
        timeoutMs: current.timeoutMs,
        deadlineAt: current.deadlineAt,
        at
      } satisfies CallTimedOut]
    })]
  })
}

// methodDeadlineCancellationReactor turns an accepted invocation deadline into the same durable cancellation used by callers.
export const methodDeadlineCancellationReactor = (methods: ActorMethods): Reactor => (log) =>
  invocationDeadlinesOf(log).flatMap(({ invocation, deadlineAt }) => {
    const cancellation = methods[invocation.method]?.cancellation
    if (cancellation === undefined || invocationSettled(log, invocation)) return []
    const alarm = firingFor(log, {
      call: invocation.id,
      method: invocation.method,
      target: "",
      timeoutMs: 0,
      deadlineAt
    })
    if (alarm === undefined || cancellation.state(log, invocation) !== "running") return []
    const request = `deadline/${invocation.method}/${invocation.id}/${invocation.epoch}/${deadlineAt}`
    return [intent({
      key: `cx:${JSON.stringify([invocation.method, invocation.id, invocation.epoch])}`,
      input: { request, invocation, deadlineAt },
      events: (current, at) => [cancellationRequested({
        request: current.request,
        invocation: current.invocation,
        cause: "deadline",
        deadlineAt: current.deadlineAt,
        at
      })]
    })]
  })

// methodTimeoutComponent mounts durable method deadlines on every actor.
export const methodTimeoutComponent = (methods: ActorMethods): Component<undefined> => ({
  name: "actor.method-timeouts",
  keys: methodTimeoutKeys,
  derive: (log) => ({
    view: undefined,
    transitions: [...methodTimeoutReactor(log), ...methodDeadlineCancellationReactor(methods)(log)]
  })
})
