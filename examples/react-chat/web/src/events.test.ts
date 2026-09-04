import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-client"

import { childThread } from "./events"

describe("childThread", () => {
  test("uses the recorded child address", () => {
    const event = {
      type: "ChildCreated",
      callId: "call-1",
      address: { actor: "react-chat", instance: "main", thread: "ag.6:turn-1call-1" }
    } as Event

    expect(childThread(event)).toBe("6:turn-1call-1")
  })

  test("does not treat a call id as a child thread", () => {
    expect(childThread({ type: "ChildCreated", callId: "call-1" } as Event)).toBeUndefined()
  })
})
