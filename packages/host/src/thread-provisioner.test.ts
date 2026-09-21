import { expect, test } from "bun:test"
import { Effect } from "effect"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import type { Event } from "@clavia/tardigrade-core/event"
import { threadCreated } from "@clavia/tardigrade-core/interaction/relations"
import { threadProvisioner } from "./thread-provisioner"

const root = { actor: "test", instance: "main", thread: "root" }
const fixture = () => {
  const logs = new Map<string, ReadonlyArray<Event>>()
  const registered: string[] = []
  const provisioner = threadProvisioner({
    placement: "colocated",
    read: (target) => Effect.sync(() => logs.get(target.thread) ?? []),
    append: (target, batch, options) => Effect.sync(() => {
      const current = logs.get(target.thread) ?? []
      if (options.expectedHead !== undefined && options.expectedHead !== current.length) return { appended: 0, head: current.length }
      logs.set(target.thread, [...current, ...batch])
      return { appended: batch.length, head: current.length + batch.length }
    }),
    register: (created) => Effect.sync(() => { registered.push(created.address.thread) })
  })
  return { logs, registered, provisioner }
}

test("root creation reuses persisted identity and leaves registration to the supervisor", async () => {
  const { provisioner, logs, registered } = fixture()
  const input = { target: root, request: { kind: "root" as const, coordinate: root } }
  const created = await Effect.runPromise(provisioner.create(input))
  expect(created).toMatchObject({ type: "ThreadCreated", address: root, depth: 0 })
  expect(await Effect.runPromise(provisioner.create(input))).toEqual(created)
  expect(logs.get(root.thread)).toEqual([created])
  expect(registered).toEqual([])
  await Effect.runPromise(provisioner.register(created))
  expect(registered).toEqual([root.thread])
})

test("child creation derives lineage and retains the requested depth ceiling", async () => {
  const { provisioner, logs } = fixture()
  logs.set(root.thread, [{ ...threadCreated(root, undefined, 0), maxDepth: 4 }])
  const child = { ...root, thread: "child" }
  const input = { target: child, request: { kind: "child" as const, parent: root, child: childKeyOf(child.thread), maxDepth: 2 } }
  const created = await Effect.runPromise(provisioner.create(input))
  expect(created).toMatchObject({ address: child, parent: root, depth: 1, maxDepth: 2, placement: "colocated" })
  expect(await Effect.runPromise(provisioner.create(input))).toEqual(created)
  expect(logs.get(child.thread)).toEqual([created])
})

test("direct provisioning refuses an invalid child ceiling without writing a log", async () => {
  const { provisioner, logs } = fixture()
  logs.set(root.thread, [{ ...threadCreated(root, undefined, 0), maxDepth: 2 }])
  const target = { ...root, thread: "child" }
  for (const maxDepth of [0, 3]) {
    await expect(Effect.runPromise(provisioner.create({ target, request: {
      kind: "child", parent: root, child: childKeyOf(target.thread), maxDepth
    } }))).rejects.toThrow("invalid lineage")
    expect(logs.get(target.thread) ?? []).toEqual([])
  }
})

test("fork creation publishes complete history once and refuses a different checkpoint", async () => {
  const { provisioner, logs } = fixture()
  const message = { type: "MessageReceived", id: "first", at: 1 }
  logs.set(root.thread, [threadCreated(root, undefined, 0), message])
  const target = { ...root, thread: "fork" }
  const request = { kind: "root" as const, coordinate: target, fork: { source: root, seq: 2 } }
  const created = await Effect.runPromise(provisioner.create({ target, request }))
  const initial = logs.get(target.thread)
  expect(initial).toEqual([created, expect.objectContaining(message), expect.objectContaining({ type: "ThreadForked" })])
  expect(await Effect.runPromise(provisioner.create({ target, request }))).toEqual(created)
  expect(logs.get(target.thread)).toEqual(initial)
  await expect(Effect.runPromise(provisioner.create({ target, request: { ...request, fork: { source: root, seq: 1 } } }))).rejects.toThrow("already has a log that is not this fork")
  expect(logs.get(target.thread)).toEqual(initial)
})
