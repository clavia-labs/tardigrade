import { describe, expect, test } from "bun:test"
import type { Event } from "../log/event"
import { methodIngressKeyOf } from "../actor/method"
import { threadAddressOf } from "./endpoint"
import { linkedEventOf, methodEnvelopeOf } from "./envelope"
import { linkOf } from "./link"

describe("method envelopes", () => {
  test("the accepted log event preserves its method and call identity", () => {
    const link = linkOf({ provider: "telegram", chat: "chat-1" }, threadAddressOf("agent", "main", "thread-1"))
    const envelope = methodEnvelopeOf(
      link,
      { invocation: { method: "message", id: "call-1", epoch: 0 } },
      { type: "PromptReceived", id: "call-1", text: "hello", at: 1 }
    )

    expect(linkedEventOf(envelope)).toEqual({
      type: "PromptReceived",
      id: "call-1",
      text: "hello",
      at: 1,
      link,
      call: { invocation: { method: "message", id: "call-1", epoch: 0 } }
    })
    expect(methodIngressKeyOf(linkedEventOf(envelope) as Event)).toBe('ming:["message","call-1",0]')
    expect(methodIngressKeyOf(envelope.event as Event)).toBeUndefined()
  })
})
