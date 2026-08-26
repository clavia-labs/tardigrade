import { describe, expect, test } from "bun:test"
import { bunAlarmScheduler } from "./alarm"

describe("bunAlarmScheduler", () => {
  test("returns an overdue alarm handle before firing", async () => {
    let returned = false
    const fired = new Promise<number>((resolve) => {
      bunAlarmScheduler.schedule(Date.now() - 1, async (at) => {
        expect(returned).toBe(true)
        resolve(at)
      })
      returned = true
    })
    expect(await fired).toBeGreaterThan(0)
  })

  test("cancels an overdue alarm before it fires", async () => {
    let fired = false
    const handle = bunAlarmScheduler.schedule(Date.now() - 1, async () => {
      fired = true
    })
    handle.cancel()
    await Bun.sleep(1)
    expect(fired).toBe(false)
  })
})
