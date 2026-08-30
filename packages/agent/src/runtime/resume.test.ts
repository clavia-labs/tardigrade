import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/log/event"
import { invokedEventOf } from "@clavia/tardigrade-core/communication/envelope"
import { resumeTurn, type TurnDriver } from "./resume"

describe("resumeTurn", () => {
  test("a resumed epoch preserves its parent and absolute deadline", async () => {
    const previous = {
      invocation: { method: "message", id: "m1", epoch: 0 },
      parent: { method: "workflow", id: "parent-1", epoch: 2 },
      deadlineAt: 50
    }
    const events: Event[] = [
      invokedEventOf(previous, { type: "MessageReceived", id: "m1", text: "hello", at: 1 }) as Event,
      { type: "TurnFailed", turn: "m1", error: "provider failed", cause: "inference_error", at: 2 } as Event
    ]
    const host: TurnDriver = {
      read: () => events,
      commitRoot: (_address, event) => { events.push(event) },
      drive: async () => {},
      self: () => "agent:main:root"
    }

    await resumeTurn(host, "root", "m1", { at: 3 })

    expect(events.at(-1)).toEqual({
      type: "TurnResumed",
      turn: "m1",
      failedEpoch: 0,
      epoch: 1,
      at: 3,
      call: {
        invocation: { method: "message", id: "m1", epoch: 1 },
        parent: previous.parent,
        deadlineAt: 50
      }
    })
  })
})
