import { describe, expect, test } from "bun:test"
import {
  createThreadDriver,
  DEFAULT_MAX_CONCURRENT_THREADS,
  driverPolicyOf
} from "./driver"

const gate = (): { readonly promise: Promise<void>; readonly open: () => void } => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe("thread driver", () => {
  test("the exported default is the resolved capacity", () => {
    expect(driverPolicyOf()).toEqual({ maxConcurrentThreads: DEFAULT_MAX_CONCURRENT_THREADS })
  })

  test("rejects a capacity that cannot schedule a thread", () => {
    expect(() => driverPolicyOf({ maxConcurrentThreads: 0 })).toThrow("positive integer")
    expect(() => driverPolicyOf({ maxConcurrentThreads: 1.5 })).toThrow("positive integer")
  })

  test("fills the configured capacity with distinct threads", async () => {
    const release = gate()
    const twoStarted = gate()
    let active = 0
    let peak = 0
    let started = 0
    const served: string[] = []
    const driver = createThreadDriver({
      policy: { maxConcurrentThreads: 2 },
      serve: async (thread) => {
        active += 1
        peak = Math.max(peak, active)
        started += 1
        served.push(thread)
        if (started === 2) twoStarted.open()
        await release.promise
        active -= 1
      }
    })
    for (const thread of ["a", "b", "c"]) driver.mark(thread)

    const draining = driver.drain()
    await twoStarted.promise
    expect(active).toBe(2)
    expect(driver.work()).toBe(3)
    expect(driver.resting()).toBe(false)
    release.open()
    await draining

    expect(peak).toBe(2)
    expect(new Set(served)).toEqual(new Set(["a", "b", "c"]))
    expect(driver.work()).toBe(0)
    expect(driver.resting()).toBe(true)
  })

  test("a delivery to an active thread waits for its next pass", async () => {
    const release = gate()
    const firstStarted = gate()
    let calls = 0
    let active = 0
    let peak = 0
    const driver = createThreadDriver({
      policy: { maxConcurrentThreads: 4 },
      serve: async () => {
        calls += 1
        active += 1
        peak = Math.max(peak, active)
        if (calls === 1) {
          firstStarted.open()
          await release.promise
        }
        active -= 1
      }
    })
    driver.mark("same")

    const draining = driver.drain()
    await firstStarted.promise
    driver.mark("same")
    release.open()
    await draining

    expect(calls).toBe(2)
    expect(peak).toBe(1)
  })

  test("a newly dirty thread fills idle capacity before the first thread finishes", async () => {
    const release = gate()
    const firstStarted = gate()
    const secondStarted = gate()
    let active = 0
    const driver = createThreadDriver({
      policy: { maxConcurrentThreads: 2 },
      serve: async (thread) => {
        active += 1
        if (thread === "a") firstStarted.open()
        if (thread === "b") secondStarted.open()
        await release.promise
        active -= 1
      }
    })
    driver.mark("a")

    const draining = driver.drain()
    await firstStarted.promise
    driver.mark("b")
    await secondStarted.promise
    expect(active).toBe(2)
    release.open()
    await draining
  })

  test("a failed thread keeps its debt for the next drive", async () => {
    let attempts = 0
    const driver = createThreadDriver({
      serve: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("crash")
      }
    })
    driver.mark("a")

    await expect(driver.drain()).rejects.toThrow("crash")
    await driver.drain()
    expect(attempts).toBe(2)
    expect(driver.resting()).toBe(true)
  })
})
