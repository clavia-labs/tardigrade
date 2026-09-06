import { expect, test } from "bun:test"
import { decodeInvocationCoordinate, invocationCoordinateJsonSchema, InvocationRef } from "./invocation"

import { Schema } from "effect"
import { ActorCoordinate, ThreadCoordinate } from "../actor/coordinate"

test("coordinates compose actor instances, threads, and local invocations", () => {
  const actor = { actor: "agent", instance: "main" }
  const thread = { ...actor, thread: "root" }
  const invocation = { method: "message", id: "call", epoch: 0 }
  expect(Schema.is(ActorCoordinate)(actor)).toBe(true)
  expect(Schema.is(ThreadCoordinate)(actor)).toBe(false)
  expect(Schema.is(ThreadCoordinate)(thread)).toBe(true)
  expect(Schema.is(ThreadCoordinate)({ ...thread, instance: "tenant:instance" })).toBe(true)
  expect(Schema.is(InvocationRef)(invocation)).toBe(true)
  expect(Schema.is(InvocationRef)({ ...invocation, epoch: -1 })).toBe(false)
  expect(decodeInvocationCoordinate({ target: thread, invocation })).toEqual({ target: thread, invocation })
})

test("the embeddable invocation schema retains nested constraints", () => {
  expect(invocationCoordinateJsonSchema).toMatchObject({
    required: ["target", "invocation"],
    properties: {
      target: { required: ["actor", "instance", "thread"], properties: { instance: { type: "string", allOf: [{ pattern: "^[\\s\\S]+$" }] } } },
      invocation: { required: ["method", "id", "epoch"], properties: { epoch: { type: "integer", allOf: [{ minimum: 0 }] } } }
    }
  })
  expect(JSON.stringify(invocationCoordinateJsonSchema)).not.toContain('"$ref"')
})
