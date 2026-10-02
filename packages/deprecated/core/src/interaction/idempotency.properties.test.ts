import { expect, test } from "bun:test"
import fc from "fast-check"
import { invocationIdForKey } from "./invocation"

const name = fc.string({ minLength: 1 })
const parent = fc.record({
  target: fc.record({ actor: name, instance: name, thread: name }),
  invocation: fc.record({ method: name, id: name, epoch: fc.nat({ max: 1000 }) })
})

test("idempotency keys preserve parent scope and survive reconstruction", () => {
  fc.assert(fc.property(parent, name, (scope, key) => {
    const id = invocationIdForKey(scope, key)
    expect(invocationIdForKey(JSON.parse(JSON.stringify(scope)), key)).toBe(id)
    const { method, id: call, epoch } = scope.invocation
    expect(invocationIdForKey({ ...scope, invocation: { epoch, id: call, method } }, key)).toBe(id)
    const neighbours = [
      ...(["actor", "instance", "thread"] as const).map((field) => ({
        ...scope, target: { ...scope.target, [field]: scope.target[field] + "x" }
      })),
      ...(["method", "id"] as const).map((field) => ({
        ...scope, invocation: { ...scope.invocation, [field]: scope.invocation[field] + "x" }
      })),
      { ...scope, invocation: { ...scope.invocation, epoch: epoch + 1 } }
    ]
    const ids = [id, invocationIdForKey(scope, key + "x"), ...neighbours.map((value) => invocationIdForKey(value, key))]
    expect(new Set(ids).size).toBe(ids.length)
  }))
})
