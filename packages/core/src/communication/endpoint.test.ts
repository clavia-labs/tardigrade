import { describe, expect, test } from "bun:test"
import { Schema } from "effect"

import {
  ActorInstanceId,
  formatThreadAddress,
  isThreadAddress,
  parseThreadAddress,
  threadAddressOf
} from "./endpoint"

describe("actor instance ids", () => {
  test("accept non-empty identifiers without the address delimiter", () => {
    for (const value of ["main", "customer-42", "team/west", "user@example.com", " "]) {
      expect(Schema.is(ActorInstanceId)(value)).toBe(true)
    }
  })

  test("reject empty and delimited identifiers", () => {
    for (const value of ["", "tenant:west"]) {
      expect(Schema.is(ActorInstanceId)(value)).toBe(false)
    }
  })
})

describe("thread addresses", () => {
  test("round-trip every valid segment", () => {
    const address = threadAddressOf("support", "team/west", "telegram:-100123:42")
    expect(parseThreadAddress(formatThreadAddress(address))).toEqual(address)
    expect(isThreadAddress(address)).toBe(true)
  })

  test("refuse an instance delimiter before serialization", () => {
    expect(() => threadAddressOf("support", "tenant:west", "root")).toThrow()
    expect(() => formatThreadAddress({ actor: "support", instance: "tenant:west", thread: "root" })).toThrow()
  })
})
