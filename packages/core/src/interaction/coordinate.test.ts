import { expect, test } from "bun:test"
import fc from "fast-check"
import { decodeInvocationCoordinate, invocationCoordinateJsonSchema, invocationCoordinateKey, invocationResponseId, invocationKey, sameInvocation, InvocationRef } from "./invocation"

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

test("invocation references separate targets, methods, calls, and epochs", () => {
  fc.assert(fc.property(fc.string({ minLength: 1 }), fc.nat({ max: 1000 }), (name, epoch) => {
    const reference = decodeInvocationCoordinate({
      target: { actor: name, instance: "main", thread: name },
      invocation: { method: "message", id: name, epoch }
    })
    const alternatives = [reference,
      ...(["actor", "instance", "thread"] as const).map((field) => ({
        ...reference, target: { ...reference.target, [field]: reference.target[field] + "x" }
      })),
      ...(["method", "id"] as const).map((field) => ({
        ...reference, invocation: { ...reference.invocation, [field]: reference.invocation[field] + "x" }
      })),
      { ...reference, invocation: { ...reference.invocation, epoch: epoch + 1 } }
    ]
    expect(new Set(alternatives.map(invocationCoordinateKey)).size).toBe(alternatives.length)
    expect(new Set(alternatives.map(invocationResponseId)).size).toBe(alternatives.length)
    expect(new Set(alternatives.map(({ invocation }) => invocationKey(invocation))).size).toBe(4)
    for (const [index, alternative] of alternatives.entries()) {
      expect(sameInvocation(reference.invocation, alternative.invocation)).toBe(index < 4)
    }
    expect(invocationCoordinateKey(decodeInvocationCoordinate(JSON.parse(JSON.stringify(reference))))).toBe(invocationCoordinateKey(reference))
  }))
})
