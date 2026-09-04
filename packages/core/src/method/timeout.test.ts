import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import {
  alarmFired,
  deadlineCancellationsAt,
  deadlineCancellationEventsAt,
  earliestDeadlineOf,
  methodDeadlineCancellationDerivation,
  methodTimeoutKeys,
  methodTimeoutDerivation
} from "./timeout"
import { legacyActorMethod } from "./legacy"
import { Schema } from "effect"

const dispatched = (
  id: string,
  deadlineAt: number,
  at = 1
): Event => ({
  type: "CallDispatched",
  id,
  method: "inspect",
  target: "inspector:shared",
  input: {},
  timeoutMs: deadlineAt - at,
  deadlineAt,
  at
})

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
        from: "inspector:shared",
        at: 5
      }
    ]
    expect(earliestDeadlineOf(log)).toBe(20)
  })

  test("an accepted invocation deadline requests method cancellation", () => {
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
        state: () => "running",
        event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, at })
      }
    })
    const invocation = { method: "work", id: "work-1", epoch: 0 } as const
    const log: ReadonlyArray<Event> = [
      { type: "WorkStarted", id: "work-1", call: { invocation, deadlineAt: 40 }, at: 1 } as Event,
      { type: "AlarmFired", scheduledFor: 40, at: 43 } as Event
    ]
    expect(earliestDeadlineOf(log.slice(0, 1))).toBe(40)
    expect(earliestDeadlineOf([
      log[0]!,
      { type: "WorkCompleted", id: "work-1", at: 20 } as Event
    ], { work })).toBeUndefined()
    const transition = methodDeadlineCancellationDerivation({ work })(log)[0]
    expect(transition?.kind).toBe("intent")
    if (transition?.kind !== "intent") return
    expect(transition.events(transition.input, 43)).toEqual([{
      type: "CancellationRequested",
      request: "deadline/work/work-1/0/40",
      invocation,
      cause: "deadline",
      deadlineAt: 40,
      at: 43
    }])
  })

  test("a crossed deadline projects its cancellation at the observed time", () => {
    const work = legacyActorMethod({
      input: Schema.String,
      output: Schema.String,
      event: ({ invocation, at }) => ({
        type: "WorkStarted",
        id: invocation.id,
        call: { invocation, deadlineAt: 40 },
        at
      }),
      state: () => ({ status: "pending" }),
      cancellation: {
        state: () => "running",
        event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, at })
      }
    })
    const invocation = { method: "work", id: "work-1", epoch: 0 } as const
    const started = {
      type: "WorkStarted",
      id: "work-1",
      call: { invocation, deadlineAt: 40 },
      at: 1
    } as Event
    expect(deadlineCancellationsAt([started], { work }, 39)).toEqual([])
    expect(deadlineCancellationsAt([started], { work }, 40)).toEqual([{ invocation, deadlineAt: 40 }])
    expect(deadlineCancellationEventsAt([started], { work }, 40)).toEqual([{
      type: "CancellationRequested",
      request: "deadline/work/work-1/0/40",
      invocation,
      cause: "deadline",
      deadlineAt: 40,
      at: 40
    }])
  })

  test("one crossing projects every crossed invocation", () => {
    const work = legacyActorMethod({
      input: Schema.String,
      output: Schema.String,
      event: ({ invocation, at }) => ({
        type: "WorkStarted",
        id: invocation.id,
        call: { invocation, deadlineAt: 40 },
        at
      }),
      state: () => ({ status: "pending" }),
      cancellation: {
        state: () => "running",
        event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, at })
      }
    })
    const first = { method: "work", id: "work-1", epoch: 0 } as const
    const second = { method: "work", id: "work-2", epoch: 0 } as const
    const started = (invocation: { readonly method: "work"; readonly id: string; readonly epoch: 0 }, deadlineAt: number) => ({
      type: "WorkStarted",
      id: invocation.id,
      call: { invocation, deadlineAt },
      at: 1
    } as Event)
    const log = [started(first, 40), started(second, 45)]
    expect(deadlineCancellationEventsAt(log, { work }, 44)).toEqual([{
      type: "CancellationRequested",
      request: "deadline/work/work-1/0/40",
      invocation: first,
      cause: "deadline",
      deadlineAt: 40,
      at: 44
    }])
    expect(deadlineCancellationEventsAt(log, { work }, 50)).toEqual([
      {
        type: "CancellationRequested",
        request: "deadline/work/work-1/0/40",
        invocation: first,
        cause: "deadline",
        deadlineAt: 40,
        at: 50
      },
      {
        type: "CancellationRequested",
        request: "deadline/work/work-2/0/45",
        invocation: second,
        cause: "deadline",
        deadlineAt: 45,
        at: 50
      }
    ])
  })

  test("a settled or terminal deadline projects no cancellation", () => {
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
    const invocation = { method: "work", id: "work-1", epoch: 0 } as const
    const started = {
      type: "WorkStarted",
      id: "work-1",
      call: { invocation, deadlineAt: 40 },
      at: 1
    } as Event
    const requested = [{
      type: "CancellationRequested",
      request: "deadline/work/work-1/0/40",
      invocation,
      cause: "deadline",
      deadlineAt: 40,
      at: 40
    } as Event]
    expect(deadlineCancellationEventsAt([started, ...requested], { work }, 41)).toEqual([])
    const completed = [{ type: "WorkCompleted", id: "work-1", at: 20 } as Event]
    expect(deadlineCancellationEventsAt([started, ...completed], { work }, 41)).toEqual([])
    expect(deadlineCancellationEventsAt([started], {}, 41)).toEqual([])
  })

  test("a crossed deadline projects its cancellation before and after commit", () => {
    const work = legacyActorMethod({
      input: Schema.String,
      output: Schema.String,
      event: ({ invocation, at }) => ({
        type: "WorkStarted",
        id: invocation.id,
        call: { invocation, deadlineAt: 40 },
        at
      }),
      state: () => ({ status: "pending" }),
      cancellation: {
        state: () => "running",
        event: (request, at) => ({ type: "WorkCancelled", id: request.invocation.id, at })
      }
    })
    const invocation = { method: "work", id: "work-1", epoch: 0 } as const
    const started = {
      type: "WorkStarted",
      id: "work-1",
      call: { invocation, deadlineAt: 40 },
      at: 1
    } as Event
    const alarmed = [started, alarmFired({ scheduledFor: 40, at: 43 })]
    const transition = methodDeadlineCancellationDerivation({ work })(alarmed)[0]
    expect(transition?.kind).toBe("intent")
    if (transition?.kind !== "intent") return
    expect(transition.events(transition.input, 43)).toEqual([{
      type: "CancellationRequested",
      request: "deadline/work/work-1/0/40",
      invocation,
      cause: "deadline",
      deadlineAt: 40,
      at: 43
    }])
    const committed = [...alarmed, ...deadlineCancellationEventsAt(alarmed, { work }, 43)]
    expect(methodDeadlineCancellationDerivation({ work })(committed)).toEqual([])
    expect(deadlineCancellationEventsAt(committed, { work }, 44)).toEqual([])
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
      target: "inspector:shared",
      timeoutMs: 39,
      deadlineAt: 40,
      at: 43
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
        from: "inspector:shared",
        at: 20
      },
      { type: "AlarmFired", scheduledFor: 40, at: 40 }
    ])).toEqual([])
  })

  test("alarm projection is independent of event order", () => {
    const log: ReadonlyArray<Event> = [
      { type: "AlarmFired", scheduledFor: 45, at: 45 },
      { type: "AlarmFired", scheduledFor: 40, at: 43 },
      dispatched("inspect-1", 40)
    ]
    const project = (events: ReadonlyArray<Event>) => methodTimeoutDerivation(events).map((transition) => ({
      key: transition.key,
      input: transition.input,
      events: transition.kind === "intent" ? transition.events(transition.input, 999) : []
    }))
    expect(project(log)).toEqual(project([...log].reverse()))
  })

  test("a response and timeout claim the same caller terminal key", () => {
    expect(methodTimeoutKeys.keyOf({ type: "ResponseReceived", call: "inspect-1" })).toBe("mterm:inspect-1")
    expect(methodTimeoutKeys.keyOf({ type: "CallTimedOut", call: "inspect-1" })).toBe("mterm:inspect-1")
  })
})
