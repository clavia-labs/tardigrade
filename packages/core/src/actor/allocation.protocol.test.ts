import { expect, test } from "bun:test"
import { Effect } from "effect"
import { allocateThread, allocateChildCoordinate as allocateChildThread, reserveRootThread, ThreadAllocator } from "./allocation"
import { childKeyOf } from "./coordinate"

const parent = { actor: "worker", instance: "main", thread: "root" }
const request = { parent, child: childKeyOf("step") }

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
