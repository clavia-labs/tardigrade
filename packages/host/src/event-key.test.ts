import { expect, test } from "bun:test"
import { hostEventKeyOf, requireDeliveryKey } from "./event-key"
import { createHost } from "./host"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"

const coordinate = { actor: "mem", instance: "main", thread: "root" }
const requested = {
  type: "Requested", at: 1,
  call: { invocation: { method: "message", id: "work", epoch: 0 }, deadlineAt: 10 }
}

test("framework identities remain keyed with or without application keys", () => {
  const keyOf = () => undefined
  for (const event of [threadCreated(coordinate, undefined, 0), requested]) {
    expect(hostEventKeyOf(event)).toBeDefined()
    expect(() => requireDeliveryKey(event, "mem:main:root", keyOf)).not.toThrow()
  }
  expect(() => requireDeliveryKey({ type: "Unkeyed" }, "mem:main:root", keyOf)).toThrow("unkeyed")
  expect(hostEventKeyOf({ type: "Done" }, () => "done:1")).toBe("done:1")
})

test("memory storage absorbs repeated invocation identities without an application key function", () => {
  const host = createHost({ actorFor: () => undefined })
  host.seed("root", [requested, requested])
  expect(host.read("root")).toHaveLength(1)
})
