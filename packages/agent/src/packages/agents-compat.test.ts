import { expect, test } from "bun:test"
import { childCreated } from "@clavia/tardigrade-core/interaction/relations"
import { childInvocationRef } from "./agents-compat"

test("recorded child handles retain their target and invocation through replay", () => {
  const parent = { actor: "agent", instance: "main", thread: "root" }
  const address = { ...parent, thread: "child" }
  const legacy = childCreated("c1", address, { parent, depth: 1 }, 1, "turn")
  expect(childInvocationRef(legacy)).toEqual({ target: address, invocation: { method: "message", id: "c1", epoch: 0 } })
  const invocation = { method: "research", id: "c1", epoch: 2 }
  const recorded = childCreated("c1", address, { parent, depth: 1 }, 1, "turn", invocation)
  expect(childInvocationRef(JSON.parse(JSON.stringify(recorded)))).toEqual({ target: address, invocation })
})
