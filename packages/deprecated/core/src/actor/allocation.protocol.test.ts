import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { allocateThread, allocateChildCoordinate as allocateChildThread, reserveRootThread, ThreadAllocator, ThreadAllocation } from "./allocation"
import { ThreadRequest } from "./supervisor"
import { childKeyOf } from "./coordinate"

const parent = { actor: "worker", instance: "main", thread: "root" }
const request = { parent, child: childKeyOf("step") }

test("allocator and supervisor reject malformed creation inputs consistently", async () => {
  const child = { kind: "child" as const, ...request }
  const root = { kind: "root" as const, coordinate: parent }
  const invalid = [
    ...[-1, 1.5, Infinity, NaN].map((maxDepth) => ({ ...child, maxDepth })),
    ...[-1, 1.5, Infinity, NaN].map((seq) => ({ ...root, fork: { source: parent, seq } })),
    { ...root, key: "" },
    { ...child, placement: "elsewhere" },
    { ...root, fork: { source: { ...parent, instance: "" }, seq: 1 } }
  ]
  let assignments = 0
  for (const input of invalid) {
    expect(Schema.is(ThreadAllocation)(input)).toBe(false)
    expect(Schema.is(ThreadRequest)({ target: parent, request: input })).toBe(false)
    await expect(Effect.runPromise(allocateThread(input as ThreadAllocation).pipe(
      Effect.provideService(ThreadAllocator, { allocate: () => Effect.sync(() => { assignments++; return parent }) })
    ))).rejects.toThrow()
  }
  expect(assignments).toBe(0)
})

test("root names can resolve to host-assigned thread identities", async () => {
  const target = { ...parent, thread: "assigned-root" }
  expect(await Effect.runPromise(allocateThread({ kind: "root", coordinate: parent }).pipe(
    Effect.provideService(ThreadAllocator, { allocate: () => Effect.succeed(target) })
  ))).toEqual(target)
  for (const foreign of [{ ...target, actor: "other" }, { ...target, instance: "other" }]) {
    await expect(Effect.runPromise(allocateThread({ kind: "root", coordinate: parent }).pipe(
      Effect.provideService(ThreadAllocator, { allocate: () => Effect.succeed(foreign) })
    ))).rejects.toThrow("preserve its actor instance")
  }
})

test("root reservation uses the allocator and preserves the requested coordinate", async () => {
  const root = reserveRootThread(parent)
  expect(await Effect.runPromise(root.pipe(Effect.provideService(ThreadAllocator, {
    allocate: (request) => {
      expect(request).toEqual({ kind: "root", coordinate: parent })
      return Effect.succeed(parent)
    }
  })))).toEqual(parent)
  await expect(Effect.runPromise(root.pipe(Effect.provideService(ThreadAllocator, {
    allocate: () => Effect.succeed({ ...parent, thread: "other" })
  })))).rejects.toThrow("preserve its requested coordinate")
})

test("allocation delegates opaque child coordinates to the host", async () => {
  const target = { ...parent, thread: "host allocated ref" }
  const result = await Effect.runPromise(allocateChildThread(request).pipe(Effect.provideService(ThreadAllocator, {
    allocate: (received) => {
      expect(received).toEqual({ kind: "child", ...request })
      return Effect.succeed(target)
    }
  })))
  expect(result).toEqual(target)
})

test("allocation rejects parent aliases and foreign actor instances", async () => {
  for (const target of [parent, { ...parent, actor: "other" }, { ...parent, instance: "other" }]) {
    await expect(Effect.runPromise(allocateChildThread(request).pipe(Effect.provideService(ThreadAllocator, {
      allocate: () => Effect.succeed(target)
    })))).rejects.toThrow("another thread in the parent's actor instance")
  }
})
