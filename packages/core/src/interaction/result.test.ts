import { expect, test } from "bun:test"
import { Schema } from "effect"
import { invocationTerminalOf, invocationResultOf } from "./result"
import { invocationResponseId } from "./invocation"
import { methodTimeoutKeys, earliestDeadlineOf, methodTimeoutDerivation, alarmFired } from "./timeout"
import { methodCallKeys } from "./invoke"
import { formatThreadAddress } from "../transport/endpoint"
import type { ResponseReceived } from "./events"

test("legacy dispatches match full references while retaining their terminal storage key", () => {
  const reference = {
    target: { actor: "agent", instance: "main", thread: "child" },
    invocation: { method: "message", id: "call", epoch: 1 }
  }
  const dispatch = {
    type: "CallDispatched", id: "call", method: "message", epoch: 1,
    target: formatThreadAddress(reference.target), timeoutMs: 9, deadlineAt: 10, at: 1
  }
  const terminal: ResponseReceived = {
    type: "ResponseReceived", id: invocationResponseId(reference), reference,
    method: "message", call: "call", status: "completed", output: "done",
    from: dispatch.target, at: 5
  }
  expect(earliestDeadlineOf([dispatch, terminal])).toBeUndefined()
  expect(earliestDeadlineOf([dispatch, { ...terminal, reference: {
    ...reference, invocation: { ...reference.invocation, epoch: 0 }
  } }])).toBe(10)
  const timeout = methodTimeoutDerivation([dispatch, alarmFired({ scheduledFor: 10, at: 10 })])[0]!
  if (timeout.kind !== "intent") throw new Error("expected timeout intent")
  const event = timeout.events(timeout.input, 10)[0]!
  expect(methodTimeoutKeys.keyOf(event)).toBe("mterm:call")
  expect(invocationTerminalOf([event], reference) === event).toBe(true)
})

test("reused calls retain separate terminals across targets and epochs", () => {
  const references = ["first", "second"].flatMap((thread) => [0, 1].map((epoch) => ({
    target: { actor: "agent", instance: "main", thread },
    invocation: { method: "message", id: "same-call", epoch }
  })))
  const terminals: ResponseReceived[] = references.map((reference, index) => ({
    type: "ResponseReceived", id: invocationResponseId(reference), reference,
    method: "message", call: "same-call", status: "completed", output: String(index),
    from: formatThreadAddress(reference.target), at: 5
  }))
  const dispatches = references.map((reference) => ({
    type: "CallDispatched", id: "same-call", method: "message", reference,
    target: formatThreadAddress(reference.target), timeoutMs: 9, deadlineAt: 10, at: 1
  }))
  expect(new Set(terminals.map(methodTimeoutKeys.keyOf)).size).toBe(4)
  expect(new Set(dispatches.map(methodCallKeys.keyOf)).size).toBe(4)
  for (const [index, reference] of references.entries()) {
    expect(invocationTerminalOf(terminals, reference)).toBe(terminals[index])
    expect(invocationTerminalOf(terminals.filter((_, i) => i !== index), reference)).toBeUndefined()
    expect(invocationResultOf(terminals[index]!, Schema.String)).toEqual({ status: "completed", output: String(index) })
    expect(methodTimeoutKeys.keyOf({
      type: "CallTimedOut", call: "same-call", reference, at: 10
    })).toBe(methodTimeoutKeys.keyOf(terminals[index]!))
  }
  expect(earliestDeadlineOf([...dispatches, ...terminals.slice(0, 3)])).toBe(10)
  expect(earliestDeadlineOf([...dispatches, ...terminals])).toBeUndefined()
})
