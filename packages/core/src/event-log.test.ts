import { describe, expect, test } from "bun:test"
import { composeKeys, type KeyFragment } from "./event-log"
import { messageKeys } from "./message"

// The key composition: first answer wins, and a claimed prefix is claimed once. A prefix
// collision would silently cross-absorb two packages' events, which is the exact class of
// quiet failure keys exist to prevent, so it dies at construction.

const aKeys: KeyFragment = {
  prefixes: ["a:"],
  keyOf: (e) => (e.type === "A" ? `a:${String((e as { id?: unknown }).id)}` : undefined)
}

describe("composeKeys", () => {
  test("first answer wins and unclaimed types answer nothing", () => {
    const keyOf = composeKeys(messageKeys, aKeys)
    expect(keyOf({ type: "MessageReceived", id: "m1", text: "", at: 0 })).toBe("msg:m1")
    expect(keyOf({ type: "A", id: "x", at: 0 })).toBe("a:x")
    expect(keyOf({ type: "ModelCalled", at: 0 })).toBeUndefined()
  })

  test("a prefix claimed twice dies at construction", () => {
    const rival: KeyFragment = { prefixes: ["a:"], keyOf: () => undefined }
    expect(() => composeKeys(aKeys, rival)).toThrow('key prefix "a:" claimed by fragments 0 and 1')
  })
})
