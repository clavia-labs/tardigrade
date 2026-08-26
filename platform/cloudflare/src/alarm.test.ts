import { describe, expect, test } from "bun:test"
import { alarmPolicyOf, armAt, DEFAULT_ALARM_DELAY_MILLIS, scheduledAlarmAt } from "./alarm"

describe("actor alarm", () => {
  test("the default states the recovery delay", () => {
    expect(alarmPolicyOf()).toEqual({ recoveryDelayMillis: DEFAULT_ALARM_DELAY_MILLIS })
  })

  test("a due alarm cannot block a new arm", () => {
    expect(armAt(100, 100, 5)).toBe(105)
  })

  test("policy rejects invalid delays", () => {
    expect(() => alarmPolicyOf({ recoveryDelayMillis: -1 })).toThrow("non-negative integer")
  })

  test("a resting actor sleeps until its method deadline", () => {
    expect(scheduledAlarmAt(105, true, 100, 5, 140)).toBe(140)
    expect(scheduledAlarmAt(105, true, 100, 5, undefined)).toBeNull()
  })

  test("active work keeps the earliest recovery or method wake", () => {
    expect(scheduledAlarmAt(null, false, 100, 20, 110)).toBe(110)
    expect(scheduledAlarmAt(105, false, 100, 20, 110)).toBe(105)
    expect(scheduledAlarmAt(90, false, 100, 20, 90)).toBe(90)
    expect(scheduledAlarmAt(null, false, 100, 20, undefined)).toBe(120)
  })
})
