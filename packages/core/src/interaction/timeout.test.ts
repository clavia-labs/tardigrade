import { describe, expect, test } from "bun:test"
import { eventAt, type Event } from "@clavia/tardigrade-core/event"
import {
  alarmFired,
  deadlineCancellationEventsAt,
  earliestDeadlineOf,
  initialMethodTimeoutState,
  methodDeadlineCancellationDerivation,
  methodTimeoutDerivation,
  methodTimeoutKeys,
  methodTimeoutTransitions,
  reduceMethodTimeoutState
} from "./timeout"
import { legacyActorMethod } from "../actor/method-compat"
import { initialMethodStates, reduceMethodStates } from "./state"
import type { ActorMethods } from "../actor/method"
import { Schema } from "effect"

const dispatched = (
  id: string,
  deadlineAt: number,
  at = 1
): Event => ({
  type: "CallDispatched",
  id,
  method: "inspect",
  target: "inspector:main:shared",
  input: {},
  timeoutMs: deadlineAt - at,
  deadlineAt,
  at
})

const work = legacyActorMethod({
  input: Schema.String,
  output: Schema.String,
  event: ({ invocation, at }) => ({
    type: "WorkStarted",
    id: invocation.id,
    call: { invocation, deadlineAt: 40 },
    at
  }),
  state: (events, invocation) => events.some((event) =>
    event.type === "WorkCompleted" && String((event as { readonly id?: unknown }).id) === invocation.id
  ) ? { status: "completed", output: "done" } : { status: "pending" },
  cancellation: {
    state: (events, invocation) => events.some((event) =>
      event.type === "WorkCompleted" && String((event as { readonly id?: unknown }).id) === invocation.id
    ) ? "terminal" : "running",
    event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, at })
  }
})
const workMethods: ActorMethods = { work }
const startedWork = (id: string, deadlineAt = 40, at = 1): Event => ({
  type: "WorkStarted",
  id,
  call: { invocation: { method: "work", id, epoch: 0 }, deadlineAt },
  at
} as Event)
const deadlineCancellation = (id: string, deadlineAt: number, at: number): Event => ({
  type: "CancellationRequested",
  request: `deadline/work/${id}/0/${deadlineAt}`,
  invocation: { method: "work", id, epoch: 0 },
  cause: "deadline",
  deadlineAt,
  at
} as Event)

describe("method alarms", () => {
  test("an alarm fact states its schedule and observed firing time", () => {
    expect(alarmFired({ scheduledFor: 40, at: 43 })).toEqual({
      type: "AlarmFired",
      scheduledFor: 40,
      at: 43
    })
    expect(() => alarmFired({ scheduledFor: 40, at: 39 })).toThrow("at or after")
  })

  test("the earliest unresolved deadline is the host's next wake", () => {
    const log: ReadonlyArray<Event> = [
      dispatched("later", 50),
      dispatched("done", 10),
      dispatched("next", 20),
      {
        type: "ResponseReceived",
        id: "done.reply",
        method: "inspect",
        call: "done",
        status: "completed",
        output: "ok",
        from: "inspector:main:shared",
        at: 5
      }
    ]
    expect(earliestDeadlineOf(log)).toBe(20)
    expect(earliestDeadlineOf([startedWork("work-1")], workMethods)).toBe(40)
    expect(earliestDeadlineOf([startedWork("work-1"), { type: "WorkCompleted", id: "work-1", at: 20 } as Event], workMethods))
      .toBeUndefined()
  })

  test("cancellation selection projects one cancellation from an eligible invocation", () => {
    const completed = { type: "WorkCompleted", id: "work-1", at: 20 } as Event
    const cases: ReadonlyArray<{
      readonly name: string
      readonly log: ReadonlyArray<Event>
      readonly at: number
      readonly expected: ReadonlyArray<Event>
      readonly methods?: ActorMethods
    }> = [
      {
        name: "overdue, running, and cancellable",
        log: [startedWork("work-1")],
        at: 40,
        expected: [deadlineCancellation("work-1", 40, 40)]
      },
      { name: "deadline still in the future", log: [startedWork("work-1")], at: 39, expected: [] },
      { name: "already settled", log: [startedWork("work-1"), completed], at: 41, expected: [] },
      {
        name: "cancellation already requested",
        log: [startedWork("work-1"), deadlineCancellation("work-1", 40, 40)],
        at: 41,
        expected: []
      },
      { name: "method does not support cancellation", log: [startedWork("work-1")], methods: {}, at: 41, expected: [] },
      {
        name: "every crossed invocation",
        log: [startedWork("work-1"), startedWork("work-2", 45)],
        at: 50,
        expected: [deadlineCancellation("work-1", 40, 50), deadlineCancellation("work-2", 45, 50)]
      }
    ]
    for (const current of cases) {
      expect(deadlineCancellationEventsAt(current.log, current.methods ?? workMethods, current.at), current.name)
        .toEqual(current.expected)
    }
  })

  test("legacy recovery derives an alarm's missing cancellation exactly once", () => {
    const log = [
      startedWork("work-1"),
      alarmFired({ scheduledFor: 40, at: 43 }),
      alarmFired({ scheduledFor: 40, at: 50 })
    ]
    const complete = methodDeadlineCancellationDerivation(workMethods)(log)
    expect(complete).toHaveLength(1)
    expect(complete.map((transition) => transition.key))
      .toEqual([JSON.stringify([1, "actor.method-timeouts", "deadline"])])
    const transition = complete[0]
    expect(transition?.kind).toBe("intent")
    if (transition?.kind !== "intent") return
    expect(transition.events(transition.input, 50)).toEqual([{ ...deadlineCancellation("work-1", 40, 50), transitionRef: { seq: 1, component: "actor.method-timeouts", tag: "deadline" } }])
    let methodStates = initialMethodStates(workMethods)
    let timeoutState = initialMethodTimeoutState()
    for (const [index, raw] of log.entries()) {
      const event = eventAt(raw, index + 1)
      methodStates = reduceMethodStates(workMethods, methodStates, event)
      timeoutState = reduceMethodTimeoutState(timeoutState, event)
    }
    expect(methodTimeoutTransitions(workMethods, methodStates, timeoutState).map((transition) => transition.key))
      .toEqual(complete.map((transition) => transition.key))
    const committed = [...log, ...deadlineCancellationEventsAt(log, workMethods, 50)]
    expect(methodDeadlineCancellationDerivation(workMethods)(committed)).toEqual([])
    expect(deadlineCancellationEventsAt(committed, workMethods, 51)).toEqual([])
  })

  test("an alarm crossing produces one caller timeout without reading a clock", () => {
    const transition = methodTimeoutDerivation([
      dispatched("inspect-1", 40),
      { type: "AlarmFired", scheduledFor: 40, at: 43 }
    ])[0]
    expect(transition?.kind).toBe("intent")
    if (transition?.kind !== "intent") return
    expect(transition.events(transition.input, 999)).toEqual([{
      type: "CallTimedOut",
      call: "inspect-1",
      method: "inspect",
      target: "inspector:main:shared",
      timeoutMs: 39,
      deadlineAt: 40,
      at: 43,
      transitionRef: { seq: 1, component: "actor.method-timeouts", tag: "timeout" }
    }])
  })

  test("an early alarm and a completed call derive no timeout", () => {
    expect(methodTimeoutDerivation([
      dispatched("inspect-1", 40),
      { type: "AlarmFired", scheduledFor: 30, at: 30 }
    ])).toEqual([])
    expect(methodTimeoutDerivation([
      dispatched("inspect-1", 40),
      {
        type: "ResponseReceived",
        id: "inspect-1.reply",
        method: "inspect",
        call: "inspect-1",
        status: "completed",
        output: "ok",
        from: "inspector:main:shared",
        at: 20
      },
      { type: "AlarmFired", scheduledFor: 40, at: 40 }
    ])).toEqual([])
  })

  test("alarm selection is independent of arrival order while references follow the owning dispatch", () => {
    const log: ReadonlyArray<Event> = [
      { type: "AlarmFired", scheduledFor: 45, at: 45 },
      { type: "AlarmFired", scheduledFor: 40, at: 43 },
      dispatched("inspect-1", 40)
    ]
    const project = (events: ReadonlyArray<Event>) => methodTimeoutDerivation(events).flatMap((transition) =>
      transition.kind === "intent" ? transition.events(transition.input, 999) : [])
    const first = project(log)[0]!
    const reversed = project([...log].reverse())[0]!
    expect(first).toMatchObject({ type: "CallTimedOut", call: "inspect-1", at: 43,
      transitionRef: { seq: 3, component: "actor.method-timeouts", tag: "timeout" } })
    expect(reversed).toEqual({ ...first, transitionRef: { seq: 1, component: "actor.method-timeouts", tag: "timeout" } })
  })

  test("a response and timeout claim the same caller terminal key", () => {
    expect(methodTimeoutKeys.keyOf({ type: "ResponseReceived", call: "inspect-1" })).toBe("mterm:inspect-1")
    expect(methodTimeoutKeys.keyOf({ type: "CallTimedOut", call: "inspect-1" })).toBe("mterm:inspect-1")
  })
})
