import fc from "fast-check"
import { expect, test, vi } from "vitest"
import { createThreadDriver } from "@clavia/tardigrade-host/driver"
import { ThreadDO } from "../src/thread"

interface DriveSurface {
  driving: Promise<void> | undefined
  kick(host: { drive: () => Promise<void>; work: () => number }): void
}

const scenario = fc.record({
  initial: fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 4 }),
  arrivals: fc.array(fc.nat({ max: 3 }), { maxLength: 8 }),
  capacity: fc.integer({ min: 1, max: 4 })
})

const surfaceFor = (synchronizeAlarm: () => Promise<void>, waitUntil = (_task: Promise<unknown>): void => {}) =>
  Object.assign(Object.create(ThreadDO.prototype) as DriveSurface, {
    backgroundTaskOwner: "request",
    ctx: { waitUntil },
    synchronizeAlarm
  })

// observeDrive exercises ThreadDO.kick with request retention and an admission gap at alarm synchronization (tla/ActiveDrive.tla, AdmissionRetained and JoinedWorkDrained).
const observeDrive = async ({ initial, arrivals, capacity }: fc.ArbitraryValue<typeof scenario>) => {
  const entered = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const retained: Array<Promise<unknown>> = []
  const driver = createThreadDriver({
    policy: { maxConcurrentThreads: capacity },
    serve: async () => {}
  })
  let synchronizations = 0
  const surface = surfaceFor(async () => {
    if (synchronizations++ === 0) {
      entered.resolve()
      await resume.promise
    }
  }, (task) => { retained.push(task) })
  const host = { drive: driver.drain, work: driver.work }
  for (const thread of initial) driver.mark(String(thread))
  surface.kick(host)
  const first = surface.driving
  await entered.promise
  const admissionsRetained: boolean[] = []
  for (const thread of arrivals) {
    driver.mark(String(thread))
    const before = retained.length
    surface.kick(host)
    admissionsRetained.push(retained.length === before + 1 && retained.at(-1) === first)
  }
  resume.resolve()
  await first
  const releasedAtCompletion = surface.driving === undefined
  const pendingAtCompletion = driver.work()
  while (surface.driving !== undefined) await surface.driving
  return { admissionsRetained, releasedAtCompletion, pendingAtCompletion }
}

test("each joining admission retains its active drive", async () => {
  await fc.assert(fc.asyncProperty(scenario, async (input) => {
    const observed = await observeDrive(input)
    expect(observed.admissionsRetained).toEqual(input.arrivals.map(() => true))
  }), { seed: 387, numRuns: 100 })
})

test("the joined drive drains arrivals before completing", async () => {
  await fc.assert(fc.asyncProperty(scenario, async (input) => {
    const observed = await observeDrive(input)
    expect(observed.releasedAtCompletion).toBe(true)
    expect(observed.pendingAtCompletion).toBe(0)
  }), { seed: 387, numRuns: 100 })
})

test.each(["throw", "reject", "synchronize"])("a %s failure releases the drive for retry", async (failure) => {
  const cause = new Error("drive failed")
  const logged = vi.spyOn(console, "error").mockImplementation(() => {})
  let fail = true
  const surface = surfaceFor(async () => {
    if (fail && failure === "synchronize") throw cause
  })
  const host = {
    drive: () => {
      if (fail && failure === "throw") throw cause
      return fail && failure === "reject" ? Promise.reject(cause) : Promise.resolve()
    },
    work: () => 0
  }
  try {
    surface.kick(host)
    const first = surface.driving
    await first
    expect(surface.driving).toBeUndefined()
    expect(logged).toHaveBeenCalledWith("actor drive failed; the alarm remains armed", cause)
    fail = false
    surface.kick(host)
    expect(surface.driving).not.toBe(first)
    await surface.driving
    expect(surface.driving).toBeUndefined()
  } finally {
    logged.mockRestore()
  }
})

test("a retiring drive cannot clear a successor admitted after its final check", async () => {
  const admitted = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  let successor: Promise<void> | undefined
  let checks = 0
  let synchronizations = 0
  const surface = surfaceFor(async () => {
    if (++synchronizations === 2) await resume.promise
  })
  const host = {
    drive: async () => {},
    work: () => {
      if (checks++ === 0) queueMicrotask(() => {
        surface.kick(host)
        successor = surface.driving
        admitted.resolve()
      })
      return 0
    }
  }
  surface.kick(host)
  const first = surface.driving
  await admitted.promise
  await first
  try {
    expect(successor).toBeDefined()
    expect(successor).not.toBe(first)
    expect(surface.driving).toBe(successor)
  } finally {
    resume.resolve()
    await successor
  }
  expect(surface.driving).toBeUndefined()
})
