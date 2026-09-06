import { expect, test } from "bun:test"
import { allocateChatThread } from "./allocate-thread"

test("new conversations retain the host-assigned identity after allocation", async () => {
  const saved: string[] = []
  const allocate = async (name: string) => {
    expect(saved).not.toContain(`host-${name}`)
    return { thread: `host-${name}` }
  }
  for (const name of ["initial", "new"]) {
    expect(await allocateChatThread(allocate, (thread) => saved.push(thread), name)).toBe(`host-${name}`)
  }
  expect(saved).toEqual(["host-initial", "host-new"])
})

test("failed allocation does not persist an unallocated name", async () => {
  const saved: string[] = []
  await expect(allocateChatThread(
    () => Promise.reject(new Error("unavailable")), (thread) => saved.push(thread), "new"
  )).rejects.toThrow("unavailable")
  expect(saved).toEqual([])
})
