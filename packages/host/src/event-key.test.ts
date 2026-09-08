import { component, transitionProjectionOf, type TransitionContext } from "@clavia/tardigrade-core/component"
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

test("host storage deduplicates runtime completions within each owning log", async () => {
  const worker = component({
    name: "worker",
    initial: () => [] as ReadonlyArray<TransitionContext>,
    step: (pending, event, ctx) => event.type === "Requested" ? [...pending, ctx] : pending,
    output: (pending) => ({
      view: undefined,
      transitions: pending.map((ctx) => ctx.intent("execute", { type: "Executed", result: "done" }))
    })
  })
  const runtime = { projections: [transitionProjectionOf(worker)], keyOf: () => undefined }
  const host = createHost({ actorFor: () => runtime })
  for (const thread of ["a", "b"]) {
    host.seed(thread, [requested])
    await host.wake(thread)
    const completion = host.read(thread).find((event) => event.type === "Executed")!
    expect(completion).toMatchObject({ type: "Executed", transitionRef: { seq: 1, component: "worker", tag: "execute" }, result: "done" })
    const before = host.read(thread).length
    host.seed(thread, [completion, completion])
    await host.wake(thread)
    expect(host.read(thread)).toHaveLength(before)
    expect(hostEventKeyOf(completion, () => "application:key")).toBe(hostEventKeyOf(completion))
  }
})
