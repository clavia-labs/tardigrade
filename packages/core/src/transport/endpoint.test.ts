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
  test("accept non-empty opaque identifiers", () => {
    for (const value of ["main", "customer-42", "team/west", "user@example.com", " ", "tenant:west", "\n"]) {
      expect(Schema.is(ActorInstanceId)(value)).toBe(true)
    }
  })

  test("reject empty and non-string identifiers", () => {
    for (const value of ["", null, 42]) {
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

  test("encode delimiters without confusing actor, instance, or thread", () => {
    const addresses = [
      threadAddressOf("support", "tenant:west", "root"),
      threadAddressOf("support:tenant", "west", "root"),
      threadAddressOf("support", "tenant", "west:root"),
      threadAddressOf("[support", "tenant", "root")
    ]
    expect(new Set(addresses.map(formatThreadAddress)).size).toBe(addresses.length)
    for (const address of addresses) expect(parseThreadAddress(formatThreadAddress(address))).toEqual(address)
  })

  test("preserve representable legacy addresses", () => {
    const address = { actor: "support", instance: "main", thread: "root:child" }
    expect(formatThreadAddress(address)).toBe("support:main:root:child")
    expect(parseThreadAddress("support:main:root:child")).toEqual(address)
    expect(parseThreadAddress("[support:main:root")).toEqual({ ...address, actor: "[support", thread: "root" })
  })

  test("reject malformed tuple addresses", () => {
    for (const value of ['["actor","instance"]', '["actor",12,"thread"]', '["actor","","thread"]']) {
      expect(() => parseThreadAddress(value)).toThrow()
    }
  })
})
