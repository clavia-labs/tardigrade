import { expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { builtInActor } from "./actor"

test("the built-in actor declares message and budget methods", () => {
  expect(Object.keys(builtInActor().methods)).toEqual(["message", "requestBudget"])
})

test("message lifecycle is available through its method declaration", () => {
  const method = builtInActor().methods.message!
  const requested = { type: "MessageReceived", id: "m1", text: "hello", at: 1 } as Event
  const failed = { type: "TurnFailed", turn: "m1", error: "boom", at: 2 } as Event
  const invocation = { method: "message", id: "m1", epoch: 0 }
  expect(method.state([requested], invocation)).toEqual({ status: "pending" })
  expect(method.state([requested, failed], invocation)).toMatchObject({ status: "failed", error: "boom" })
  expect(method.state([requested, { type: "TurnCompleted", turn: "m1", output: "42", at: 2 } as Event], invocation)).toMatchObject({ status: "completed", output: "42" })
  expect(method.state([], invocation)).toBeUndefined()
})
