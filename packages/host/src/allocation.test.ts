import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { registeredThreadAllocator, memoryThreadDirectory, initializingThreadAllocator, threadSlug } from "./allocation"
import type { ThreadAllocation } from "@clavia/tardigrade-core/actor/allocation"

const parent = { actor: "tardie", instance: "rick", thread: "main" }
const child = (name: string): ThreadAllocation => ({ kind: "child", parent, child: childKeyOf(name) })

test("slugs use configurable words and a short random token", () => {
  expect(threadSlug()).toMatch(/^[a-z]+-[a-z]+-[a-z2-7]{4}$/)
  expect(threadSlug({ adjectives: ["quiet"], nouns: ["fox"], tokenLength: 6 })).toMatch(/^quiet-fox-[a-z2-7]{6}$/)
})

test("concurrent retries and a reopened allocator recover the persisted assignment", async () => {
  const store = memoryThreadDirectory()
  let generated = 0
  const policy = { generate: () => `quiet-fox-${generated++}` }
  const allocator = registeredThreadAllocator(store, policy)
  const results = await Promise.all(Array.from({ length: 20 }, () => Effect.runPromise(allocator.allocate(child("researcher")))))
  expect(new Set(results.map((result) => result.thread)).size).toBe(1)
  const reopened = registeredThreadAllocator(store, { generate: () => { throw new Error("must reuse assignment") } })
  expect(await Effect.runPromise(reopened.allocate(child("researcher")))).toEqual(results[0]!)
})

test("collisions retry and exhaustion fails without aliasing another thread", async () => {
  const store = memoryThreadDirectory()
  const first = registeredThreadAllocator(store, { generate: () => "quiet-fox-abcd", maxAttempts: 2 })
  await Effect.runPromise(first.allocate(child("first")))
  await expect(Effect.runPromise(first.allocate(child("second")))).rejects.toThrow("exhausted 2")
  let calls = 0
  const retry = registeredThreadAllocator(store, { generate: () => calls++ === 0 ? "quiet-fox-abcd" : "bright-owl-efgh" })
  expect((await Effect.runPromise(retry.allocate(child("second")))).thread).toBe("bright-owl-efgh")
})

test("roots, children, and existing threads cannot claim each other's IDs", async () => {
  const store = memoryThreadDirectory((target) => target.thread === "occupied")
  const candidates = ["occupied", "main", "quiet-fox-abcd", "quiet-fox-abcd", "bright-owl-efgh"]
  const allocator = registeredThreadAllocator(store, { generate: () => candidates.shift()! })
  const root = await Effect.runPromise(allocator.allocate({ kind: "root", coordinate: parent }))
  const spawned = await Effect.runPromise(allocator.allocate(child("researcher")))
  const unnamed = await Effect.runPromise(allocator.allocate({ kind: "root", coordinate: { ...parent, thread: "" }, key: "create" }))
  expect([root.thread, spawned.thread, unnamed.thread]).toEqual(["main", "quiet-fox-abcd", "bright-owl-efgh"])
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
      const roots = [root, { ...root, [coordinate]: root[coordinate] + "x" }]
      const seen = new Set(roots.map((value) => JSON.stringify(value)))
      let frontier = roots
      for (let level = 0; level < depth; level++) {
        const descendants = await Promise.all(frontier.flatMap((parent) => names.map(async (name) => {
          const request: ThreadAllocation = { kind: "child", parent, child: childKeyOf(name) }
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

test("root initialization finishes before allocation returns and failures propagate", async () => {
  const allocator = registeredThreadAllocator(memoryThreadDirectory())
  const initialized: string[] = []
  const service = initializingThreadAllocator(allocator, async (target) => { initialized.push(target.thread) })
  const target = await Effect.runPromise(service.allocate({ kind: "root", coordinate: parent }))
  expect(initialized).toEqual([target.thread])
  await Effect.runPromise(service.allocate(child("researcher")))
  expect(initialized).toHaveLength(1)
  await expect(Effect.runPromise(initializingThreadAllocator(allocator,
    () => Promise.reject(new Error("storage unavailable"))
  ).allocate({ kind: "root", coordinate: parent }))).rejects.toThrow("storage unavailable")
})
