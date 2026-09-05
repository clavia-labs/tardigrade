import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { METHOD_SEALED_EVENT_TYPE, methodIsSealed, methodSealOf, methodSealed } from "./seal"
import { methodIngressKeyOf, methodSealKey } from "./call"

describe("method seals", () => {
  test("the seal constructor refuses an empty method and an unsafe time", () => {
    expect(() => methodSealed({ method: "", at: 1 })).toThrow("sealed method must not be empty")
    expect(() => methodSealed({ method: "message", at: -1 })).toThrow("sealed method time must be a non-negative safe integer")
    expect(() => methodSealed({ method: "message", at: 1.5 })).toThrow("sealed method time must be a non-negative safe integer")
    expect(methodSealed({ method: "message", reason: "deleted", at: 1 })).toEqual({
      type: "MethodSealed",
      method: "message",
      reason: "deleted",
      at: 1
    })
    expect(methodSealed({ method: "message", at: 1 })).toEqual({
      type: "MethodSealed",
      method: "message",
      at: 1
    })
  })

  test("the decoder accepts only well-formed seals", () => {
    const seal = methodSealed({ method: "message", reason: "deleted", at: 1 })
    expect(methodSealOf(seal)).toEqual(seal)
    expect(methodSealOf({ type: "MessageReceived", id: "m1", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: -1 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: 1.5 } as Event)).toBeUndefined()
    expect(methodSealOf({ type: "MethodSealed", method: "message", at: 1, reason: 3 } as Event)).toBeUndefined()
  })

  test("a sealed method stays sealed", () => {
    const log = [
      { type: "MessageReceived", id: "m1", at: 1 } as Event,
      methodSealed({ method: "message", at: 2 })
    ]
    expect(methodIsSealed(log, "message")).toBe(true)
    expect(methodIsSealed(log, "requestBudget")).toBe(false)
    expect(methodIsSealed([], "message")).toBe(false)
    expect(log[1]!.type).toBe(METHOD_SEALED_EVENT_TYPE)
  })

  test("a seal owns its ingress key, so the store keys and refuses on it", () => {
    const seal = methodSealed({ method: "message", at: 1 })
    expect(methodIngressKeyOf(seal)).toBe(methodSealKey("message"))
    expect(methodSealKey("message")).toBe(`mseal:${JSON.stringify("message")}`)
    expect(methodIngressKeyOf({ type: "MessageReceived", id: "m1", at: 1 } as Event)).toBeUndefined()
    expect(methodSealOf(seal)!.method).toBe("message")
  })
})
