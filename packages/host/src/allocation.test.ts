import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { registeredThreadAllocator, memoryThreadDirectory, threadSlug } from "./allocation"
import { allocateThread, ThreadAllocator, type ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"
import type { Event } from "@clavia/tardigrade-core/event"

const parent = { actor: "tardie", instance: "rick", thread: "main" }
const child = (name: string): ThreadAllocation => ({ kind: "child", parent, child: childKeyOf(name) })

test("assignments survive replay without requiring parent directory records", async () => {
  const directories = new Map<string, Event[]>()
  const open = (records: Map<string, Event[]>) => registeredThreadAllocator(memoryThreadDirectory(undefined, undefined, records))
  const allocator = open(directories)
  const request = { ...child("researcher"), key: "call-123" }
  const assigned = await Effect.runPromise(allocator.allocate(request))
  expect(await Effect.runPromise(allocator.allocate(request))).toEqual(assigned)
  const unrelated = { kind: "root" as const, coordinate: { ...parent, thread: "unrelated" } }
  expect(await Effect.runPromise(allocator.allocate(unrelated))).toEqual(unrelated.coordinate)
  const recovered = open(new Map(JSON.parse(JSON.stringify([...directories]))))
  expect(await Effect.runPromise(recovered.allocate(request))).toEqual(assigned)
  expect(await Effect.runPromise(recovered.allocate(child("another")))).toEqual({ ...parent, thread: "another" })
  await expect(Effect.runPromise(recovered.allocate({ kind: "root", coordinate: assigned }))).rejects.toThrow("already taken")
})

test("slugs use configurable words and a short random token", () => {
  expect(threadSlug()).toMatch(/^[a-z]+-[a-z]+-[a-z2-7]{4}$/)
  expect(threadSlug({ adjectives: ["quiet"], nouns: ["fox"], tokenLength: 6 })).toMatch(/^quiet-fox-[a-z2-7]{6}$/)
})

test("roots, children, and existing threads cannot claim each other's IDs", async () => {
  const store = memoryThreadDirectory((target) => target.thread === "occupied")
  const candidates = ["occupied", "main", "quiet-fox-abcd", "quiet-fox-abcd", "bright-owl-efgh"]
  const allocator = registeredThreadAllocator(store, { generate: () => candidates.shift()! })
  const root = await Effect.runPromise(allocator.allocate({ kind: "root", coordinate: parent }))
  const spawned = await Effect.runPromise(allocator.allocate({ ...child("researcher"), key: "spawn" }))
  const unnamed = await Effect.runPromise(allocator.allocate({ kind: "root", coordinate: { ...parent, thread: "" }, key: "create" }))
  expect([root.thread, spawned.thread, unnamed.thread]).toEqual(["main", "quiet-fox-abcd", "bright-owl-efgh"])
})

test("named allocations use the name and report conflicts without generating a replacement", async () => {
  const store = memoryThreadDirectory((target) => target.thread === "occupied")
  const allocator = registeredThreadAllocator(store, { generate: () => { throw new Error("named allocation must not generate") } })
  const run = (request: ThreadAllocation) => Effect.runPromise(allocator.allocate(request))
  expect((await run({ kind: "root", coordinate: parent })).thread).toBe("main")
  const request = child("researcher")
  expect((await run(request)).thread).toBe("researcher")
  expect((await run(request)).thread).toBe("researcher")
  await expect(run(child("main"))).rejects.toThrow('thread name "main" is already taken')
  await expect(run(child("occupied"))).rejects.toThrow('thread name "occupied" is already taken')
  await expect(run({ ...request, kind: "child", parent: { ...parent, thread: "other" }, child: childKeyOf("researcher") })).rejects.toThrow("already taken")
  await expect(run({ kind: "root", coordinate: { ...parent, thread: "researcher" } })).rejects.toThrow("already taken")
  await expect(run({ kind: "root", coordinate: { ...parent, thread: "occupied" } })).rejects.toThrow("already taken")
})

test("distinct scopes and names separate trees at every depth", async () => {
  await fc.assert(fc.asyncProperty(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.constantFrom("actor", "instance", "thread"),
    fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 3 }),
    fc.integer({ min: 2, max: 4 }),
    async (name, coordinate, names, depth) => {
      const store = memoryThreadDirectory()
      const allocator = registeredThreadAllocator(store)
      const root = { ...parent, thread: name }
      const roots = await Promise.all([root, { ...root, [coordinate]: root[coordinate] + "x" }].map((coordinate) =>
        Effect.runPromise(allocator.allocate({ kind: "root", coordinate }))))
      const seen = new Set(roots.map((value) => JSON.stringify(value)))
      let frontier = roots
      for (let level = 0; level < depth; level++) {
        const descendants = await Promise.all(frontier.flatMap((parent) => names.map(async (name) => {
          const request: ThreadAllocation = { kind: "child", parent, child: childKeyOf(name), key: name }
          const target = await Effect.runPromise(allocator.allocate(request))
          expect(await Effect.runPromise(registeredThreadAllocator(store).allocate(request))).toEqual(target)
          return target
        })))
        for (const target of descendants) {
          const identity = JSON.stringify(target)
          expect(seen.has(identity)).toBe(false)
          seen.add(identity)
        }
        frontier = descendants
      }
    }
  ))
})

test("fork publication input survives allocator normalization", async () => {
  const requests: ThreadAllocation[] = []
  const allocator: typeof ThreadAllocator.Service = { allocate: (request) => Effect.sync(() => {
    requests.push(request)
    return parent
  }) }
  const request = { kind: "root" as const, coordinate: parent, fork: { source: { ...parent, thread: "source" }, seq: 1 } }
  expect(await Effect.runPromise(allocateThread(request).pipe(Effect.provideService(ThreadAllocator, allocator)))).toEqual(parent)
  expect(requests).toEqual([request])
})
