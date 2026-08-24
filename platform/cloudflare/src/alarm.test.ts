import { describe, expect, test } from "bun:test"
import { alarmPolicyOf, armAt, DEFAULT_ALARM_DELAY_MILLIS } from "./alarm"

describe("actor alarm", () => {
  test("the default states the watchdog delay", () => {
    expect(alarmPolicyOf()).toEqual({ delayMillis: DEFAULT_ALARM_DELAY_MILLIS })
  })

  test("a due alarm cannot block a new arm", () => {
    expect(armAt(100, 100, 5)).toBe(105)
  })

  test("policy rejects invalid delays", () => {
    expect(() => alarmPolicyOf({ delayMillis: -1 })).toThrow("non-negative integer")
  })
})
