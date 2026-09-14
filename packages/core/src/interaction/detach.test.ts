import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { Event } from "../event"
import { legacyActorMethod } from "../actor/method-compat"
import { formatThreadAddress } from "../transport/endpoint"
import { invocationDetached } from "./detach"
import { openChildInvocationsOf } from "./relations"
import { actorCall } from "./invoke"
import { earliestDeadlineOf, methodTimeoutDerivation, initialMethodTimeoutState, reduceMethodTimeoutState, methodTimeoutTransitions } from "./timeout"
import type { ResponseReceived } from "./events"

const parent = { actor: "agent", instance: "main", thread: "parent" }
const reference = {
  target: { ...parent, thread: "child" },
  invocation: { method: "ask", id: "call", epoch: 0 }
}
const outgoing = invocationDetached({ direction: "outgoing", reference, at: 3 })
const incoming = invocationDetached({ direction: "incoming", reference, at: 3 })
const response: ResponseReceived = {
  type: "ResponseReceived", id: "response", reference, method: "ask", call: "call",
  status: "completed", output: "answer", from: formatThreadAddress(reference.target), at: 4
}
const methods = {
  ask: legacyActorMethod({
    input: Schema.String, output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "Asked", id: invocation.id, input, at }),
    state: () => ({ status: "completed", output: "answer" })
  })
}

test("a detached call stops waiting and generating timeouts without a response", () => {
  const dispatch = { type: "CallDispatched", reference, id: "call", method: "ask", target: response.from, input: "work", timeoutMs: 10, deadlineAt: 11, at: 1 }
  const log = [dispatch, outgoing, { type: "AlarmFired", scheduledFor: 11, at: 11 }]
  const call = actorCall(log, { id: "call", target: { coordinate: reference.target, methods }, method: "ask", input: "work", timeoutMs: 10 })
  expect(call.state.status).toBe("detached")
  expect(call.transitions).toEqual([])
  expect(earliestDeadlineOf(log)).toBeUndefined()
  expect(methodTimeoutDerivation(log)).toEqual([])
  const projected = log.reduce(reduceMethodTimeoutState, initialMethodTimeoutState())
  expect(methodTimeoutTransitions({}, new Map(), projected)).toEqual([])
  expect(actorCall([dispatch, response, outgoing], { id: "call", target: { coordinate: reference.target, methods }, method: "ask", input: "work", timeoutMs: 10 }).state)
    .toEqual({ status: "completed", output: "answer" })
})

test("detaching a parent wait leaves the original child relationship open", () => {
  const parentInvocation = { method: "run", id: "parent-call", epoch: 0 }
  const linked = {
    type: "InvocationLinked", parent: parentInvocation,
    owner: { type: "invocation", ref: parentInvocation },
    child: { invocation: reference.invocation }, target: formatThreadAddress(reference.target), at: 1
  }
  const original = [linked]
  expect(openChildInvocationsOf(original)).toHaveLength(1)
  expect(openChildInvocationsOf([...original, outgoing])).toEqual([])
  expect(openChildInvocationsOf([...original, incoming])).toHaveLength(1)
  expect(openChildInvocationsOf(original)).toHaveLength(1)
})
