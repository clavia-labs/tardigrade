import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Alarm, alarmEventKeyOf, alarmFromLog, alarmSet, nextAlarmOf } from "./alarm"
import type { Event } from "./event"
import { alarmFiredForLog, methodTimeoutKeys } from "./interaction/timeout"

describe("durable alarms", () => {
  test("a firing settles due requests and leaves the next wake", () => {
    const history = [alarmSet("first", 50), alarmSet("second", 80), alarmSet("same-time", 50)]
    expect(nextAlarmOf(history)).toBe(50)
    expect(nextAlarmOf([...history, { type: "AlarmFired", scheduledFor: 50, at: 53 }])).toBe(80)
    expect(nextAlarmOf([...history, { type: "AlarmFired", scheduledFor: 50, at: 53 },
      { type: "AlarmFired", scheduledFor: 80, at: 80 }])).toBeUndefined()
  })

  test("a new request after a firing remains outstanding", () => {
    expect(nextAlarmOf([alarmSet("old", 50), { type: "AlarmFired", scheduledFor: 50, at: 53 }, alarmSet("new", 50)])).toBe(50)
  })

  test("replayed set does not rearm a completed request", async () => {
    const events: Event[] = []
    const service = alarmFromLog({
      append: (batch) => Effect.sync(() => { events.push(...batch) }),
      read: Effect.succeed(events),
      head: Effect.sync(() => events.length),
      readFrom: (mark) => Effect.sync(() => events.slice(mark))
    })
    await Effect.runPromise(Alarm.set("retry", 50).pipe(Effect.provideService(Alarm, service)))
    expect(alarmEventKeyOf(events[0]!)).toBe("alarm-set:\"retry\"")
    events.push({ type: "AlarmFired", scheduledFor: 50, at: 53 })
    await Effect.runPromise(Alarm.set("retry", 50).pipe(Effect.provideService(Alarm, service)))
    expect(events.filter((event) => event.type === "AlarmSet")).toHaveLength(1)
    expect(nextAlarmOf(events)).toBeUndefined()
  })

  test("a repeated deadline keeps its own firing", () => {
    const first = alarmFiredForLog([alarmSet("first", 50)], { scheduledFor: 50, at: 53 })
    const second = alarmFiredForLog([alarmSet("first", 50), first, alarmSet("new", 50)], { scheduledFor: 50, at: 54 })
    expect(nextAlarmOf([alarmSet("first", 50), first, alarmSet("new", 50), second])).toBeUndefined()
    expect(methodTimeoutKeys.keyOf(first)).not.toBe(methodTimeoutKeys.keyOf(second))
  })
})
