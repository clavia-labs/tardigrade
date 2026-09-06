import { expect, test } from "bun:test"
import { receivedEventOf } from "./receive"
import { methodEnvelopeOf, invokedEventOf } from "./envelope"

const target = { actor: "worker", instance: "main", thread: "task" }
const link = { source: { ...target, thread: "caller" }, target }
const context = { invocation: { method: "run", id: "call", epoch: 2 }, deadlineAt: 100 }
const event = { type: "Requested", at: 1 }

test("root and routed ingress preserve the same invocation context", () => {
  const root = receivedEventOf({ target, event: invokedEventOf(context, event) })
  const routed = receivedEventOf({ target, ...methodEnvelopeOf(link, context, event) })
  expect(routed).toEqual({ ...root, link })
  expect(receivedEventOf({ target, ...methodEnvelopeOf(link, context, root) })).toEqual(routed)
})

test("ingress rejects malformed and conflicting contexts before persistence", () => {
  const invalid = { ...context, deadlineAt: -1 }
  expect(() => receivedEventOf({ target, event: { ...event, call: invalid } })).toThrow()
  expect(() => receivedEventOf({ target, event, link, call: invalid })).toThrow()
  for (const call of [
    { ...context, invocation: { ...context.invocation, epoch: 3 } },
    { ...context, deadlineAt: 101 },
    { ...context, parent: { method: "run", id: "parent", epoch: 0 } }
  ]) {
    expect(() => receivedEventOf({ target, event: invokedEventOf(context, event), link, call })).toThrow("does not match")
  }
  expect(() => receivedEventOf({ target: { ...target, thread: "other" }, event, link })).toThrow("does not match target")
})

test("ordinary events and response call strings remain unchanged", () => {
  expect(receivedEventOf({ target, event })).toBe(event)
  const reply = { type: "ResponseReceived", call: "call", at: 2 }
  expect(receivedEventOf({ target, event: reply, link })).toBe(reply)
})
