import { describe, expect, test } from "bun:test"
import type { Event } from "@clavia/tardigrade-core/event"
import { actorInvocationContextFrom, methodIngressKeyOf } from "../method"
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

  test("the complete invocation context is validated at the envelope boundary", () => {
    const link = linkOf({ provider: "telegram", chat: "chat-1" }, threadAddressOf("agent", "main", "thread-1"))
    const context = {
      invocation: { method: "message", id: "call-1", epoch: 1 },
      parent: { method: "workflow", id: "parent-1", epoch: 2 },
      deadlineAt: 10
    }
    const accepted = linkedEventOf(methodEnvelopeOf(link, context, { type: "PromptReceived", at: 1 })) as Event

    expect(actorInvocationContextFrom(accepted)).toEqual(context)
    expect(() => methodEnvelopeOf(link, { ...context, deadlineAt: -1 }, { type: "PromptReceived", at: 1 })).toThrow()
    expect(() => methodEnvelopeOf(link, {
      ...context,
      parent: { method: "workflow", id: "parent-1", epoch: -1 }
    }, { type: "PromptReceived", at: 1 })).toThrow()
    expect(methodIngressKeyOf({ ...accepted, call: { ...context, deadlineAt: 1.5 } } as Event)).toBeUndefined()
  })
})
