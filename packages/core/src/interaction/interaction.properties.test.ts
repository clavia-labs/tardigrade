import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { actorCoordinateOf, threadCoordinateOf } from "../actor/coordinate"

import { formatThreadAddress, parseThreadAddress } from "../transport/endpoint"
import { decodeInvocationCoordinate, invocationCoordinateKey, invocationResponseId, invocationKey, sameInvocation, InvocationCoordinate, invocationCoordinateOf } from "./invocation"
import { Schema } from "effect"
import { invocationTerminalOf } from "./result"
import type { ResponseReceived } from "./events"

const localRef = fc.oneof(
  fc.string({ minLength: 1 }),
  fc.constantFrom(":", "/", "[]", '"', "\\", "\u0000", "子", "a:b", "a/b")
)
const invocation = fc.record({ method: localRef, id: localRef, epoch: fc.nat({ max: 1000 }) })
const coordinate = fc.record({ target: fc.record({ actor: localRef, instance: localRef, thread: localRef }), invocation })

const neighboursOf = (reference: InvocationCoordinate): ReadonlyArray<InvocationCoordinate> => [
  ...(["actor", "instance", "thread"] as const).map((field) => ({
    ...reference, target: { ...reference.target, [field]: reference.target[field] + "x" }
  })),
  ...(["method", "id"] as const).map((field) => ({
    ...reference, invocation: { ...reference.invocation, [field]: reference.invocation[field] + "x" }
  })),
  { ...reference, invocation: { ...reference.invocation, epoch: reference.invocation.epoch + 1 } }
]

const replyOf = (reference: InvocationCoordinate, output: string): ResponseReceived => ({
  type: "ResponseReceived", reference, output, status: "completed",
  id: "transport-local-reply", from: formatThreadAddress(reference.target),
  method: reference.invocation.method, call: reference.invocation.id, epoch: reference.invocation.epoch, at: 0
})

describe("interaction identity without hashing", () => {
  test("local refs remain opaque through actor, thread, and invocation composition", () => {
    fc.assert(fc.property(coordinate, (reference) => {
      const { actor, instance } = reference.target
      const parent = actorCoordinateOf(actor, instance)
      expect(parent).toEqual({ actor, instance })
      expect(threadCoordinateOf(parent, reference.target.thread)).toEqual(reference.target)
      const full = invocationCoordinateOf(reference.target, reference.invocation)
      expect(full).toEqual(reference)
      expect(Schema.is(InvocationCoordinate)(full)).toBe(true)
      expect(Schema.is(InvocationCoordinate)(reference.invocation)).toBe(false)
      expect(decodeInvocationCoordinate(reference)).toEqual(reference)
    }), { examples: [[{
      target: { actor: "agent", instance: "tenant:main", thread: "root" },
      invocation: { method: "message", id: "call", epoch: 0 }
    }]] })
  })

  test("changing any parent scope or local ref separates the full invocation identity", () => {
    fc.assert(fc.property(coordinate, (reference) => {
      const references = [reference, ...neighboursOf(reference)]
      expect(new Set(references.map(invocationCoordinateKey)).size).toBe(references.length)
      expect(new Set(references.map(invocationResponseId)).size).toBe(references.length)
      expect(new Set(references.map(({ invocation }) => invocationKey(invocation))).size).toBe(4)
      for (const [index, alternative] of references.entries()) {
        expect(sameInvocation(reference.invocation, alternative.invocation)).toBe(index < 4)
      }
    }))
  })

  test("invocation composition rejects invalid attempts and requires the owning thread", () => {
    fc.assert(fc.property(coordinate, (reference) => {
      expect(() => invocationCoordinateOf(reference.target, { ...reference.invocation, epoch: -1 })).toThrow()
      expect(() => invocationCoordinateOf(reference.target, { ...reference.invocation, epoch: 0.5 })).toThrow()
      expect(Schema.is(InvocationCoordinate)({ invocation: reference.invocation })).toBe(false)
    }))
  })

  test("moving text across coordinate boundaries cannot alias another invocation", () => {
    fc.assert(fc.property(coordinate, localRef, (reference, suffix) => {
      const left = { ...reference, invocation: { ...reference.invocation, method: reference.invocation.method + suffix } }
      const right = { ...reference, invocation: { ...reference.invocation, id: suffix + reference.invocation.id } }
      expect(invocationCoordinateKey(left)).not.toBe(invocationCoordinateKey(right))
      const first = { ...reference, target: { ...reference.target, actor: reference.target.actor + suffix } }
      const second = { ...reference, target: { ...reference.target, thread: suffix + reference.target.thread } }
      expect(invocationCoordinateKey(first)).not.toBe(invocationCoordinateKey(second))
    }))
  })

  test("reconstructing the same coordinates preserves identity across serialization and field order", () => {
    fc.assert(fc.property(coordinate, (reference) => {
      const reconstructed = decodeInvocationCoordinate(JSON.parse(JSON.stringify({
        invocation: { epoch: reference.invocation.epoch, id: reference.invocation.id, method: reference.invocation.method },
        target: { thread: reference.target.thread, instance: reference.target.instance, actor: reference.target.actor }
      })))
      expect(reconstructed).toEqual(reference)
      expect(invocationCoordinateKey(reconstructed)).toBe(invocationCoordinateKey(reference))
    }))
  })

  test("only the exact invocation accepts a reply despite reused reply IDs", () => {
    fc.assert(fc.property(coordinate, fc.nat(), (reference, position) => {
      const unrelated = neighboursOf(reference).map((other) => replyOf(other, "unrelated"))
      expect(invocationTerminalOf(unrelated, reference)).toBeUndefined()
      const matching = replyOf(reference, "matching")
      const events = [...unrelated]
      events.splice(position % (events.length + 1), 0, matching)
      expect(invocationTerminalOf(events, reference)).toBe(matching)
    }))
  })

  test("wire encoding preserves opaque coordinates without changing their identity", () => {
    fc.assert(fc.property(coordinate, (reference) => {
      const target = parseThreadAddress(formatThreadAddress(reference.target))
      expect(target).toEqual(reference.target)
      expect(invocationCoordinateKey({ ...reference, target })).toBe(invocationCoordinateKey(reference))
    }))
  })
})
