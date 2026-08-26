import type { Event } from "../../log/event"
import type { KeyFragment } from "../../log"
import { intent, type Reactor } from "../../reconciliation"
import type { Component } from "../component"

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

// earliestDeadlineOf projects the next physical wake from unresolved durable method calls.
export const earliestDeadlineOf = (log: ReadonlyArray<Event>): number | undefined => {
  const terminal = terminalCalls(log)
  let earliest: number | undefined
  for (const dispatch of dispatchesOf(log)) {
    if (terminal.has(dispatch.call)) continue
    earliest = earliest === undefined ? dispatch.deadlineAt : Math.min(earliest, dispatch.deadlineAt)
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

// methodTimeoutComponent mounts durable method deadlines on every actor.
export const methodTimeoutComponent: Component<undefined> = {
  name: "actor.method-timeouts",
  keys: methodTimeoutKeys,
  derive: (log) => ({ view: undefined, transitions: methodTimeoutReactor(log) })
}
