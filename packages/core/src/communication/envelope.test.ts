import { describe, expect, test } from "bun:test"
import { threadAddressOf } from "./endpoint"
import { linkedEventOf, methodEnvelopeOf } from "./envelope"
import { linkOf } from "./link"

describe("method envelopes", () => {
  test("the accepted log event preserves its method and call identity", () => {
    const link = linkOf({ provider: "telegram", chat: "chat-1" }, threadAddressOf("agent", "main", "thread-1"))
    const envelope = methodEnvelopeOf(
      link,
      { method: "message", id: "call-1" },
      { type: "PromptReceived", id: "call-1", text: "hello", at: 1 }
    )

    expect(linkedEventOf(envelope)).toEqual({
      type: "PromptReceived",
      id: "call-1",
      text: "hello",
      at: 1,
      link,
      call: { method: "message", id: "call-1" }
    })
  })
})
