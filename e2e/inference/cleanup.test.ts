import { expect, test } from "bun:test"
import { cleanup, registerCleanup } from "./cleanup"

test("cleanup releases remaining acquisitions after a closer fails", async () => {
  const tasks: Array<() => unknown> = []
  const closed: string[] = []
  const close = (name: string) => { closed.push(name) }
  registerCleanup(tasks, "storage", close)
  const releaseOldHost = registerCleanup(tasks, "old host", close)
  await releaseOldHost()
  registerCleanup(tasks, "new host", close)
  const error = new Error("server close failed")
  registerCleanup(tasks, "server", (name) => { close(name); throw error })

  const failure = await cleanup(tasks).catch((cause: unknown) => cause)
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([error])
  expect(closed).toEqual(["old host", "server", "new host", "storage"])
})
