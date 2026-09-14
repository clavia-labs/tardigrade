import { expect, test } from "bun:test"
import fc from "fast-check"
import { Effect } from "effect"
import { childKeyOf } from "@clavia/tardigrade-core/actor/coordinate"
import { registeredThreadAllocator, memoryThreadDirectory, initializingThreadAllocator, durableThreadInitializer, threadSlug } from "./allocation"
import type { ThreadAllocation, ThreadAllocator } from "@clavia/tardigrade-core/actor/allocation"

const parent = { actor: "tardie", instance: "rick", thread: "main" }
const child = (name: string): ThreadAllocation => ({ kind: "child", parent, child: childKeyOf(name) })

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

test("caller-owned root initialization survives allocator normalization without running startup", async () => {
  const requests: ThreadAllocation[] = []
  const allocator: typeof ThreadAllocator.Service = { allocate: (request) => Effect.sync(() => {
    requests.push(request)
    return parent
  }) }
  const unexpected = async () => { throw new Error("caller owns initialization") }
  const service = initializingThreadAllocator(allocator, unexpected, unexpected)
  const request = { kind: "root" as const, coordinate: parent, initialization: "caller" as const }
  expect(await Effect.runPromise(service.allocate(request))).toEqual(parent)
  expect(requests).toEqual([request])
})


test.each(["root", "child"] as const)("%s allocation waits for setup and retries a failed setup at the same coordinate", async (kind) => {
  const store = memoryThreadDirectory()
  const request: ThreadAllocation = kind === "root" ? { kind, coordinate: parent } : child("researcher")
  const started = Promise.withResolvers<void>()
  const setup = Promise.withResolvers<void>()
  const attempts: string[] = []
  let published = false
  let returned = false
  const allocator = initializingThreadAllocator(registeredThreadAllocator(store), async () => { published = true }, async (target) => {
    attempts.push(target.thread)
    started.resolve()
    await setup.promise
  })
  const pending = Effect.runPromise(allocator.allocate(request)).then(
    () => { returned = true; return undefined },
    (error: unknown) => error
  )
  await started.promise
  expect(returned).toBe(false)
  expect(published).toBe(false)
  setup.reject(new Error("setup failed"))
  expect(await pending).toBeInstanceOf(Error)
  expect(published).toBe(false)

  const recovered = initializingThreadAllocator(registeredThreadAllocator(store), async () => { published = true }, async (target) => {
    attempts.push(target.thread)
  })
  const target = await Effect.runPromise(recovered.allocate(request))
  expect(attempts).toEqual([target.thread, target.thread])
  expect(published).toBe(kind === "root")
})


test("setup completion survives a new host wrapper and concurrent callers share setup", async () => {
  const completed = new Set<string>()
  const store = {
    completed: async (target: typeof parent) => completed.has(JSON.stringify(target)),
    complete: async (target: typeof parent) => { completed.add(JSON.stringify(target)) }
  }
  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let attempts = 0
  const initialize = async () => { attempts++; started.resolve(); await release.promise }
  const tracked = durableThreadInitializer(initialize, store)
  const request: ThreadAllocation = { kind: "root", coordinate: parent }
  const first = tracked(parent, request)
  await started.promise
  const second = tracked(parent, request)
  expect(attempts).toBe(1)
  expect(completed.size).toBe(0)
  release.resolve()
  await Promise.all([first, second])
  await durableThreadInitializer(initialize, store)(parent, request)
  expect(attempts).toBe(1)
  const other = { ...parent, instance: "other" }
  await tracked(other, { kind: "root", coordinate: other })
  expect(attempts).toBe(2)
})

test.each(["setup", "commit"])("a failed %s leaves initialization retryable", async (failure) => {
  let completed = false
  let attempts = 0
  let fail = true
  const tracked = durableThreadInitializer(async () => {
    attempts++
    if (fail && failure === "setup") throw new Error("setup unavailable")
  }, {
    completed: async () => completed,
    complete: async () => {
      if (fail && failure === "commit") throw new Error("commit unavailable")
      completed = true
    }
  })
  const request: ThreadAllocation = { kind: "root", coordinate: parent }
  await expect(tracked(parent, request)).rejects.toThrow(`${failure} unavailable`)
  expect(completed).toBe(false)
  fail = false
  await tracked(parent, request)
  expect(completed).toBe(true)
  expect(attempts).toBe(2)
})
