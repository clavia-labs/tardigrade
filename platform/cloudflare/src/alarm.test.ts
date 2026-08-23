import { describe, expect, test } from "bun:test"
import { alarmPolicyOf, armAt, nextAlarm } from "./alarm"

describe("actor alarm", () => {
  test("an alarm scheduled during a pass survives quiet stale answers", () => {
    expect(nextAlarm(101, false, 100)).toBe(101)
  })

  test("durable debt arms a quiet slot", () => {
    expect(nextAlarm(null, true, 100, { delayMillis: 7 })).toBe(107)
  })

  test("a quiet pass with no concurrent arm clears", () => {
    expect(nextAlarm(null, false, 100)).toBeNull()
  })

  test("a due alarm cannot block a new arm", () => {
    expect(armAt(100, 100, 5)).toBe(105)
  })

  test("policy rejects invalid delays", () => {
    expect(() => alarmPolicyOf({ delayMillis: -1 })).toThrow("non-negative integer")
  })
})
