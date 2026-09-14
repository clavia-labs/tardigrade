import { expect, test } from "bun:test"
import { Schema } from "effect"
import { eventAt, type Event } from "../event"
import { legacyActorMethod } from "../actor/method-compat"
import { formatThreadAddress } from "../transport/endpoint"
import { linkOf } from "../transport/link"
import { invocationDetached, invocationDetachmentKeys, replyStateOf } from "./detach"
import { callStateOf } from "./result"
import { openChildInvocationsOf } from "./relations"
import { actorCall } from "./invoke"
import { initialMethodResponseState, reduceMethodResponseState, methodResponseTransitions, methodResponseDerivation } from "./respond"
import { earliestDeadlineOf, methodTimeoutDerivation, initialMethodTimeoutState, reduceMethodTimeoutState, methodTimeoutTransitions } from "./timeout"
import type { ResponseReceived, ResponseDelivered, CallTimedOut } from "./events"

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
const delivery: ResponseDelivered = { type: "ResponseDelivered", method: "ask", call: "call", at: 4 }
const methods = {
  ask: legacyActorMethod({
    input: Schema.String, output: Schema.String,
    event: ({ invocation, input, at }): Event => ({ type: "Asked", id: invocation.id, input, at }),
    state: () => ({ status: "completed", output: "answer" })
  })
}
const accepted = eventAt({
  type: "Asked", id: "call", call: { invocation: reference.invocation },
  link: linkOf(parent, reference.target), at: 1
}, 1)

test("detachment preserves the first call and reply terminal in log order", () => {
  expect(callStateOf([outgoing, response], reference)).toEqual({ status: "detached", detachment: outgoing })
  expect(callStateOf([response, outgoing], reference)).toEqual({ status: "received", response })
  expect(replyStateOf([incoming, delivery], reference)).toEqual({ status: "detached", detachment: incoming })
  expect(replyStateOf([delivery, incoming], reference)).toEqual({ status: "sent", delivery })
  expect(callStateOf([incoming], reference)).toEqual({ status: "pending" })
  expect(replyStateOf([outgoing], reference)).toEqual({ status: "pending" })
  const timeout: CallTimedOut = { type: "CallTimedOut", reference, method: "ask", call: "call", target: response.from, timeoutMs: 10, deadlineAt: 11, at: 11 }
  expect(callStateOf([timeout, outgoing], reference)).toEqual({ status: "timed-out", timeout })
  expect(callStateOf([outgoing, timeout], reference).status).toBe("detached")
})

test("detachment identity includes direction and every invocation coordinate field", () => {
  const others = [
    ...["actor", "instance", "thread"].map((field) => ({ ...reference, target: { ...reference.target, [field]: "other" } })),
    ...["method", "id"].map((field) => ({ ...reference, invocation: { ...reference.invocation, [field]: "other" } })),
    { ...reference, invocation: { ...reference.invocation, epoch: 1 } }
  ]
  for (const other of others) {
    expect(callStateOf([outgoing], other).status).toBe("pending")
    expect(replyStateOf([incoming], other).status).toBe("pending")
  }
  const events = [incoming, outgoing, ...others.map((reference) => invocationDetached({ direction: "outgoing", reference, at: 3 }))]
  expect(new Set(events.map(invocationDetachmentKeys.keyOf)).size).toBe(events.length)
  expect(invocationDetachmentKeys.keyOf({ ...outgoing, at: 99 })).toBe(invocationDetachmentKeys.keyOf(outgoing))
})

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

test("incoming detachment suppresses replayed replies while preserving computation and originals", () => {
  const original = [accepted]
  const fork = [...original, incoming]
  expect(methods.ask.state(fork, reference.invocation)).toEqual({ status: "completed", output: "answer" })
  expect(methodResponseDerivation(methods)(original)).toHaveLength(1)
  for (const log of [fork, [...fork, delivery], [accepted, delivery, incoming]]) {
    expect(methodResponseDerivation(methods)(log)).toEqual([])
    const projected = log.reduce(reduceMethodResponseState, initialMethodResponseState())
    expect(methodResponseTransitions(methods, projected, () => ({ status: "completed", output: "answer" }))).toEqual([])
    expect(projected.replies.values().next().value?.status).toBe(replyStateOf(log, reference).status)
  }
  const wrongTarget = invocationDetached({ direction: "incoming", reference: { ...reference, target: { ...reference.target, thread: "fork" } }, at: 3 })
  for (const log of [original, [...original, outgoing], [...original, wrongTarget]]) {
    expect(methodResponseDerivation(methods)(log)).toHaveLength(1)
    expect(methodResponseTransitions(methods, log.reduce(reduceMethodResponseState, initialMethodResponseState()), () => ({ status: "completed", output: "answer" }))).toHaveLength(1)
  }
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
