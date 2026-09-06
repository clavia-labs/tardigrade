import { expect, test } from "bun:test"
import { Effect } from "effect"
import { defineActor } from "./definition"
import { allocateRootThread, allocateChildThread, ThreadAllocator, ThreadAllocationScope, type ThreadAllocation } from "./allocation"

import type { ThreadCoordinate } from "./coordinate"

const allocator = () => {
  const requests: ThreadAllocation[] = []
  const children = new Map<string, ThreadCoordinate>()
  const service: typeof ThreadAllocator.Service = {
    allocate: (request) => Effect.sync(() => {
      requests.push(request)
      if (request.kind === "root") return request.coordinate
      const key = JSON.stringify([request.parent, request.child])
      const address = children.get(key) ?? { ...request.parent, thread: `assigned-${children.size}` }
      children.set(key, address)
      return address
    })
  }
  return { requests, service }
}

test("allocation is lazy and both surfaces use the same host allocator", async () => {
  const host = allocator()
  const tardie = defineActor("tardie", {}, [])
  const root = tardie.allocateRootThread({ instance: "rick", name: "main" })
  expect(host.requests).toEqual([])
  const run = <A>(effect: Effect.Effect<A, never, ThreadAllocator>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(ThreadAllocator, host.service)))
  const rick = await run(root)
  expect(rick.address).toEqual({ actor: "tardie", instance: "rick", thread: "main" })
  expect(rick.methods).toBe(tardie.methods)
  expect(await run(allocateRootThread(tardie, { instance: "rick", name: "main" }))).toEqual(rick)
  const child = await run(tardie.allocateChildThread({ parent: rick, name: "researcher" }))
  expect(child.address).toEqual({ actor: "tardie", instance: "rick", thread: "assigned-0" })
  expect(child.methods).toBe(tardie.methods)
  expect(await run(allocateChildThread(tardie, { parent: rick, name: "researcher" }))).toEqual(child)
  expect(host.requests.map((request) => request.kind)).toEqual(["root", "root", "child", "child"])
})

test("a foreign actor parent is rejected before allocation", async () => {
  const host = allocator()
  const tardie = defineActor("tardie", {}, [])
  const effect = tardie.allocateChildThread({
    parent: { address: { actor: "other", instance: "rick", thread: "main" }, methods: {} },
    name: "researcher"
  })
  await expect(Effect.runPromise(effect.pipe(Effect.provideService(ThreadAllocator, host.service))))
    .rejects.toThrow("child allocation requires a parent from the same actor definition")
  expect(host.requests).toEqual([])
})

test("unnamed requests use action identity or an explicit retry key, otherwise create fresh requests", async () => {
  const tardie = defineActor("tardie", {}, [])
  const requests: ThreadAllocation[] = []
  const service: typeof ThreadAllocator.Service = { allocate: (request) => Effect.sync(() => {
    requests.push(request)
    const target = request.kind === "root" ? request.coordinate : request.parent
    return { ...target, thread: "assigned" }
  }) }
  const run = (key?: string) => tardie.allocateRootThread({ instance: "rick", ...(key === undefined ? {} : { key }) }).pipe(
    Effect.provideService(ThreadAllocator, service)
  )
  await Effect.runPromise(run())
  await Effect.runPromise(run())
  expect(requests[0]?.key).not.toBe(requests[1]?.key)
  await Effect.runPromise(run("retry"))
  await Effect.runPromise(run("retry"))
  expect(requests[2]?.key).toBe(requests[3]?.key)
  await Effect.runPromise(run().pipe(Effect.provideService(ThreadAllocationScope, { key: () => "action/0" })))
  expect(requests[4]?.key).toBe("action/0")
  await expect(Effect.runPromise(tardie.allocateRootThread({ instance: "rick", name: "main", key: "retry" }).pipe(
    Effect.provideService(ThreadAllocator, service)
  ))).rejects.toThrow("named allocations do not accept a separate key")
})
