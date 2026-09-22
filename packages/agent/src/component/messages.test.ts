import { expect, test } from "bun:test"
import { replayProjection } from "@clavia/tardigrade-core/projection"
import { testMachineOf } from "../../fixtures/component"
import { messages } from "./messages"

test("messages exposes committed conversation data without proposed work", () => {
  const history = [{ type: "MessageReceived", id: "turn", text: "Hello", at: 1 }]
  const output = replayProjection(testMachineOf(messages()), history)
  expect(output.view.messages?.[0]?.trajectory).toEqual(history)
  expect(output.transitions).toEqual([])
  expect(output.interactions).toBeUndefined()
})
