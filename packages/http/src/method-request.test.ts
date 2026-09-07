import { expect, test } from "bun:test"
import { Schema } from "effect"
import { legacyActorMethod } from "@clavia/tardigrade-core/actor/method-compat"
import { existingMethodRequest, prepareMethodRequest, methodRequestState, methodCancellationRequest, methodCancellationEvent } from "./method-request"

const method = legacyActorMethod({
  input: Schema.String, output: Schema.String, timeoutMs: 100,
  event: ({ input, invocation, at }) => ({ type: "Started", input, epoch: invocation.epoch, at }),
  state: (events, invocation) => events.some((event) => event.type === "Started" && event.epoch === invocation.epoch)
    ? { status: "pending" } : undefined,
  cancellation: {
    state: (events) => events.some((event) => event.type === "Completed") ? "terminal"
      : events.some((event) => event.type === "Cancelled") ? "cancelled" : "running",
    event: (_request, at) => ({ type: "Cancelled", at })
  }
})
const reference = {
  target: { actor: "worker", instance: "tenant", thread: "root" },
  invocation: { method: "run", id: "call", epoch: 0 }
}
const prepared = prepareMethodRequest({ reference, method, input: "hello", at: 10, timeoutMs: 20 })

test("HTTP receipts and retries preserve the exact reference and recorded deadline", () => {
  expect(prepared.accepted).toEqual({ reference, actor: "tenant", thread: "root", method: "run", call: "call", deadlineAt: 30 })
  expect(existingMethodRequest([prepared.event], reference)).toEqual(prepared.accepted)
  expect(existingMethodRequest([prepared.event], { ...reference, invocation: { ...reference.invocation, epoch: 1 } })).toBeUndefined()
  expect(() => prepareMethodRequest({ reference, method, input: 12, at: 10 })).toThrow("invalid")
})

test("explicit epochs override legacy current-epoch selection", () => {
  const declaration = { ...method, currentEpoch: () => 4 }
  const request = { method: "run", id: "call" }
  expect(methodRequestState([prepared.event], declaration, request)).toEqual({
    invocation: { ...request, epoch: 4 }, state: undefined
  })
  expect(methodRequestState([prepared.event], declaration, { ...request, epoch: 0 }).state).toEqual({ status: "pending" })
})

test("HTTP cancellation distinguishes missing, unsupported, pending, requested, cancelled, and settled calls", () => {
  const request = reference.invocation
  const cancel = methodCancellationEvent(request, 11, "stop")
  expect(methodCancellationRequest([], method, request).status).toBe("unknown")
  const { cancellation: _cancellation, ...unsupported } = method
  expect(methodCancellationRequest([prepared.event], unsupported, request).status).toBe("unsupported")
  for (const [tail, status] of [
    [[], "requestable"],
    [[cancel], "requested"],
    [[{ type: "Cancelled", at: 12 }], "cancelled"],
    [[{ type: "Completed", at: 12 }], "settled"]
  ] as const) {
    expect(methodCancellationRequest([prepared.event, ...tail], method, request).status).toBe(status)
  }
  expect(cancel).toMatchObject({ invocation: request, cause: "requested", reason: "stop", at: 11 })
  expect(methodCancellationEvent(request, 12).request).toBe(cancel.request)
})
