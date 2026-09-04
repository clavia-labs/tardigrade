import { describe, expect, test } from "bun:test"
import { messageKeys } from "../communication/message"
import { composeKeys, keysFor, type KeyFragment } from "./keys"

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

describe("keysFor", () => {
  test("an unlisted type lands unkeyed", () => {
    const operationKeys = keysFor("op:", {
      OperationCompleted: (event) => String((event as { operation?: unknown }).operation)
    })
    expect(operationKeys.keyOf({ type: "OperationCompleted", operation: "one" })).toBe("op:one")
    expect(operationKeys.keyOf({ type: "OperationFailed", operation: "one" })).toBeUndefined()
  })
})
