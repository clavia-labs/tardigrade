import { expect, test } from "bun:test"
import { normalizeAction, type LegacyCallAction } from "./action-compat"

test("legacy action conversion retains response metadata outside the calls array", () => {
  const legacy: LegacyCallAction = { kind: "call", callId: "a", name: "read", arguments: {}, text: "Reading", usage: { promptTokens: 12, completionTokens: 2 } }
  const action = normalizeAction(legacy)
  expect(action).toEqual({ kind: "calls", calls: [{ callId: "a", name: "read", arguments: {} }], text: "Reading", usage: { promptTokens: 12, completionTokens: 2 } })
  expect(normalizeAction(action)).toBe(action)
})
