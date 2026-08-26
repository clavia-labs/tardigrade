import { describe, expect, test } from "bun:test"
import type { Event } from "../../log/event"
import {
  alarmFired,
  earliestDeadlineOf,
  methodTimeoutKeys,
  methodTimeoutReactor
} from "./timeout"

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

  test("an alarm crossing produces one caller timeout without reading a clock", () => {
    const transition = methodTimeoutReactor([
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
    expect(methodTimeoutReactor([
      dispatched("inspect-1", 40),
      { type: "AlarmFired", scheduledFor: 30, at: 30 }
    ])).toEqual([])
    expect(methodTimeoutReactor([
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
    const project = (events: ReadonlyArray<Event>) => methodTimeoutReactor(events).map((transition) => ({
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
