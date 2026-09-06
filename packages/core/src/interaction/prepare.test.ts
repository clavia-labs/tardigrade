import { expect, test } from "bun:test"
import { Schema } from "effect"
import { legacyActorMethod } from "../actor/method-compat"
import { prepareInvocation } from "./prepare"

const method = legacyActorMethod({
  input: Schema.String, output: Schema.String, timeoutMs: 100,
  event: ({ input, at }) => ({ type: "Requested", input, at }),
  state: () => undefined
})
const reference = {
  target: { actor: "agent", instance: "main", thread: "root" },
  invocation: { method: "message", id: "call", epoch: 2 }
}
const options = { reference, method, input: "hello", at: 1000 }

test("fresh preparation applies declared, overridden, and inherited deadlines", () => {
  expect(prepareInvocation(options).context.deadlineAt).toBe(1100)
  expect(prepareInvocation({ ...options, timeoutMs: 20 }).context.deadlineAt).toBe(1020)
  const parent = { invocation: { method: "message", id: "parent", epoch: 1 }, deadlineAt: 1010 }
  const prepared = prepareInvocation({ ...options, parent })
  expect(prepared.context).toEqual({ invocation: reference.invocation, parent: parent.invocation, deadlineAt: 1010 })
  expect(prepared.event).toMatchObject({ input: "hello", call: prepared.context })
  expect(() => prepareInvocation({ ...options, timeoutMs: 101 })).toThrow("declared")
})

test("reconstruction preserves recorded context without applying a fresh deadline", () => {
  const context = prepareInvocation(options).context
  expect(prepareInvocation({ ...options, at: 5000, context }).context).toEqual(context)
  const unbounded = { invocation: reference.invocation }
  expect(prepareInvocation({ ...options, context: unbounded }).context).toEqual(unbounded)
})

test("preparation rejects invalid input and mismatched invocation coordinates", () => {
  expect(() => prepareInvocation({ ...options, input: 123 })).toThrow('method "message" is invalid')
  expect(() => prepareInvocation({ ...options, context: { invocation: { ...reference.invocation, epoch: 3 } } })).toThrow("does not match")
  expect(() => prepareInvocation({ ...options, reference: { ...reference, invocation: { ...reference.invocation, epoch: -1 } } })).toThrow()
})
